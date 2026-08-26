// Tests for the PreToolUse guard — the hook that turns three prompt-only "hard rails" into actual
// refusals for the unattended box sweeps.
//
//   bun test .claude/hooks/guard-protected-files.test.ts
//
// These exist because the guard shipped BROKEN and looked fine. It parsed its payload with `jq`,
// `jq` is absent from the Hermes container, and without `set -e` the empty result fell through the
// `[ -z "$file" ] && exit 0` line as "nothing to check". Every edit on the box was allowed, by a
// hook that reported success every time. So the suite asserts BOTH halves: that a forbidden call is
// refused, AND that a guard which cannot parse refuses rather than waves through. A test that only
// checked the happy path would have passed against the broken version.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const HOOK = join(import.meta.dir, "guard-protected-files.sh");

type Payload = { command?: string; file_path?: string; tool: string };

/** Feed the hook one payload. exit 2 = refused (and the reason goes to Claude on stderr). */
function runGuard(p: Payload, env: Record<string, string> = {}): { code: number; why: string } {
  const body = JSON.stringify({
    tool_input: {
      ...(p.file_path ? { file_path: p.file_path } : {}),
      ...(p.command ? { command: p.command } : {}),
    },
    tool_name: p.tool,
  });
  const r = spawnSync("bash", [HOOK], {
    encoding: "utf8",
    env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "", ...env },
    input: body,
  });
  return { code: r.status ?? -1, why: r.stderr ?? "" };
}

const UNATTENDED = { FLUNCLE_UNATTENDED: "1" };

describe("always-on rules — every session, operator included", () => {
  test("a Drizzle migration cannot be hand-edited", () => {
    expect(runGuard({ file_path: "/ws/apps/web/drizzle/0099_x.sql", tool: "Write" }).code).toBe(2);
    expect(
      runGuard({ file_path: "/ws/apps/web/drizzle/meta/_journal.json", tool: "Edit" }).code,
    ).toBe(2);
  });

  test("an env/secret file cannot be edited", () => {
    for (const f of ["/ws/.env", "/ws/.env.local", "/ws/apps/web/.dev.vars"]) {
      expect(runGuard({ file_path: f, tool: "Write" }).code).toBe(2);
    }
  });

  test("ordinary source files are untouched — the guard is not just 'deny everything'", () => {
    expect(runGuard({ file_path: "/ws/apps/web/src/routes/index.tsx", tool: "Edit" }).code).toBe(0);
    expect(runGuard({ file_path: "/ws/apps/web/src/db/schema.ts", tool: "Edit" }).code).toBe(0);
  });
});

describe("Bash is matched — the hole the Edit|Write-only matcher left open", () => {
  test("a shell redirection into a protected path is refused", () => {
    // The exact shape that walked past the previous guard.
    expect(runGuard({ command: "cat > /ws/.env", tool: "Bash" }).code).toBe(2);
    expect(runGuard({ command: "tee /ws/apps/web/drizzle/0099_x.sql", tool: "Bash" }).code).toBe(2);
  });

  test("interactively, merely READING a local .env is allowed", () => {
    // The operator debugging their own machine is not the threat model.
    expect(runGuard({ command: "cat .env", tool: "Bash" }).code).toBe(0);
  });

  test("unattended, reading it is refused too — reading is half of exfiltrating", () => {
    expect(runGuard({ command: "cat .env", tool: "Bash" }, UNATTENDED).code).toBe(2);
  });

  test("an ordinary build command is not caught by the .env pattern", () => {
    // Guards against the obvious false positive: substrings like "environment" or "--env".
    for (const c of [
      "bun run build",
      "echo environment",
      "bun test --env-file x",
      "rg env apps/",
    ]) {
      expect(runGuard({ command: c, tool: "Bash" }, UNATTENDED).code).toBe(0);
    }
  });
});

describe("unattended tier — prompt rails become refusals", () => {
  const cases: Array<[string, Payload]> = [
    ["a CI workflow", { file_path: "/ws/.github/workflows/quality-checks.yml", tool: "Write" }],
    ["the guard's own settings", { file_path: "/ws/.claude/settings.json", tool: "Write" }],
    ["the guard itself", { file_path: "/ws/.claude/hooks/guard-protected-files.sh", tool: "Edit" }],
    [
      "the auth-tier module",
      { file_path: "/ws/apps/web/src/lib/server/orpc-auth.ts", tool: "Edit" },
    ],
    ["a workflow via Bash", { command: "sed -i s/a/b/ .github/workflows/e2e.yml", tool: "Bash" }],
    ["the guard via Bash", { command: "rm .claude/hooks/guard-protected-files.sh", tool: "Bash" }],
  ];

  for (const [name, payload] of cases) {
    test(`${name} is refused in an unattended run`, () => {
      expect(runGuard(payload, UNATTENDED).code).toBe(2);
    });
    test(`${name} is still editable interactively`, () => {
      // The operator must be able to maintain these; the tier split is the whole design.
      expect(runGuard(payload).code).toBe(0);
    });
  }
});

describe("FAIL CLOSED — the failure mode that shipped", () => {
  /**
   * Model the container precisely: bash and the coreutils the hook itself needs are present, and
   * bun/node/jq are NOT. Starving PATH entirely would only prove that `bash` cannot be launched,
   * which tests nothing about the guard.
   */
  function starvedPath(): { dir: string; path: string } {
    const dir = mkdtempSync(join(tmpdir(), "fluncle-guard-starved-"));
    try {
      for (const bin of ["bash", "sed", "dirname"]) {
        const found = spawnSync("sh", ["-c", `command -v ${bin}`], {
          encoding: "utf8",
        }).stdout.trim();
        if (found) {
          symlinkSync(found, join(dir, bin));
        }
      }
    } catch (error) {
      rmSync(dir, { force: true, recursive: true });
      throw error;
    }
    temporaryDirectories.push(dir);
    return { dir, path: dir };
  }

  test("with no bun, node, or jq on PATH the guard REFUSES instead of allowing", () => {
    // Reproduces the container the sweeps actually run in. The old hook exited 0 here, for every
    // call, forever. If this test ever goes green with code 0 again, the guard is decorative.
    const starved = starvedPath();
    try {
      const r = runGuard(
        { file_path: "/ws/apps/web/src/a.ts", tool: "Edit" },
        { PATH: starved.path },
      );
      expect(r.code).toBe(2);
      expect(r.why).toContain("Refusing the call rather than allowing it unchecked");
    } finally {
      rmSync(starved.dir, { force: true, recursive: true });
    }
  });

  test("a malformed payload is refused, not ignored", () => {
    const r = spawnSync("bash", [HOOK], {
      encoding: "utf8",
      env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "" },
      input: "this is not json",
    });
    expect(r.status).toBe(2);
  });
});
