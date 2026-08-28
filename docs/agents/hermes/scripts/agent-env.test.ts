// Unit tests for agent-env.sh — the per-caller credential scrub that stands between the box's
// secrets and an agentic `claude -p` whose prompt may carry attacker-written text.
//
//   bun test docs/agents/hermes/scripts/agent-env.test.ts
//
// The scrub's whole value is that the DEFAULT IS DENY and that capability grows for one caller
// without growing for its neighbours. Both of those are properties a test can pin, and both were
// wrong in the first version of this file (one global allowlist shared by three sweeps), so they
// are what this suite asserts. The end-to-end proof that the real driver actually applies this to a
// real child process lives in sentry-triage-sweep.test.ts.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AGENT_ENV_SH = join(import.meta.dir, "agent-env.sh");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

/** A secrets file shaped like the box's: `export`-prefixed and bare lines, comments, blanks. */
function writeSecrets(keys: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "fluncle-agent-env-"));
  temporaryDirectories.push(dir);
  const file = join(dir, "secrets.env");
  writeFileSync(
    file,
    [
      "# op-injected",
      "",
      ...keys.map((k, i) => (i % 2 === 0 ? `${k}=v-${i}` : `export ${k}=v-${i}`)),
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}

/**
 * Source the helper, call it with `args`, and report the resulting `env -u` list plus the log line.
 * Returning the flat argv is the honest assertion target — it is literally what reaches `env`.
 */
function scrub(secretsFile: string, args: string): { argv: string[]; log: string } {
  const script = `
    . "${AGENT_ENV_SH}"
    agent_env_scrub_args --secrets "${secretsFile}" ${args}
    printf '%s\\n' "\${AGENT_ENV_SCRUB[@]+\${AGENT_ENV_SCRUB[@]}}"
  `;
  const r = spawnSync("bash", ["-uo", "pipefail", "-c", script], { encoding: "utf8" });
  return { argv: (r.stdout ?? "").trim().split(/\s+/).filter(Boolean), log: r.stderr ?? "" };
}

/** The NAMES the helper decided to strip (drop the repeated `-u` flags). */
function scrubbedNames(argv: string[]): string[] {
  return argv.filter((a) => a !== "-u").sort();
}

const BOX_KEYS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "FLUNCLE_AUDIT_GITHUB_PAT",
  "SENTRY_TRIAGE_TOKEN",
  "TURSO_AUTH_TOKEN",
  "R2_SECRET_ACCESS_KEY",
  "GEMINI_API_KEY",
];

describe("default is deny", () => {
  test("an undeclared key is scrubbed", () => {
    const names = scrubbedNames(scrub(writeSecrets(BOX_KEYS), "--allow GH_TOKEN").argv);
    for (const key of [
      "SENTRY_TRIAGE_TOKEN",
      "TURSO_AUTH_TOKEN",
      "R2_SECRET_ACCESS_KEY",
      "GEMINI_API_KEY",
    ]) {
      expect(names).toContain(key);
    }
  });

  test("declaring nothing scrubs everything except the runtime's own auth", () => {
    const names = scrubbedNames(scrub(writeSecrets(BOX_KEYS), "").argv);
    expect(names).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(names.length).toBe(BOX_KEYS.length - 1);
  });

  test("a key added to the file later is scrubbed with no code change", () => {
    // The reason the list is derived from the file rather than hardcoded.
    const names = scrubbedNames(
      scrub(writeSecrets([...BOX_KEYS, "SOME_FUTURE_API_KEY"]), "--allow GH_TOKEN").argv,
    );
    expect(names).toContain("SOME_FUTURE_API_KEY");
  });
});

describe("the runtime's own auth is never scrubbed", () => {
  test("CLAUDE_CODE_OAUTH_TOKEN survives without being declared", () => {
    // A sweep that scrubbed this could not start at all, so varying it per caller buys nothing.
    expect(scrubbedNames(scrub(writeSecrets(BOX_KEYS), "").argv)).not.toContain(
      "CLAUDE_CODE_OAUTH_TOKEN",
    );
  });
});

describe("capability is per-caller — the footgun the first version had", () => {
  test("one caller declaring Turso does NOT grant it to a caller that did not", () => {
    // This is the property that matters. If it ever fails, the allowlist has gone global again and
    // widening it for the audit sweep silently arms the attacker-facing sentry-triage sweep.
    const file = writeSecrets(BOX_KEYS);
    const permissive = scrubbedNames(scrub(file, "--allow GH_TOKEN --allow TURSO_AUTH_TOKEN").argv);
    const strict = scrubbedNames(scrub(file, "--allow GH_TOKEN").argv);

    expect(permissive).not.toContain("TURSO_AUTH_TOKEN");
    expect(strict).toContain("TURSO_AUTH_TOKEN");
  });

  test("a declared key is kept, and only that key", () => {
    const names = scrubbedNames(
      scrub(writeSecrets(BOX_KEYS), "--allow FLUNCLE_AUDIT_GITHUB_PAT").argv,
    );
    expect(names).not.toContain("FLUNCLE_AUDIT_GITHUB_PAT");
    expect(names).toContain("SENTRY_TRIAGE_TOKEN");
  });
});

describe("--scrub covers what the file does not define", () => {
  test("a name absent from the secrets file is still stripped", () => {
    // GOOGLE_APPLICATION_CREDENTIALS is exported by audit-sweep independently of the file.
    const names = scrubbedNames(
      scrub(writeSecrets(BOX_KEYS), "--scrub GOOGLE_APPLICATION_CREDENTIALS").argv,
    );
    expect(names).toContain("GOOGLE_APPLICATION_CREDENTIALS");
  });
});

describe("it announces itself, so a 03:30 failure is diagnosable", () => {
  test("the log names what was kept and what was scrubbed", () => {
    const { log } = scrub(writeSecrets(BOX_KEYS), "--allow GH_TOKEN --allow TURSO_AUTH_TOKEN");
    expect(log).toContain("kept:");
    expect(log).toContain("TURSO_AUTH_TOKEN");
    expect(log).toContain("scrubbed:");
    expect(log).toContain("SENTRY_TRIAGE_TOKEN");
  });

  test("it logs NAMES only — never a value", () => {
    // The log line exists to make failures readable; it must not become a secret-disclosure path.
    const { log } = scrub(writeSecrets(BOX_KEYS), "--allow GH_TOKEN");
    expect(log).not.toContain("v-0");
    expect(log).not.toContain("v-2");
  });
});

describe("shape", () => {
  test("the argv is well-formed `-u NAME` pairs", () => {
    const { argv } = scrub(writeSecrets(BOX_KEYS), "--allow GH_TOKEN");
    expect(argv.length % 2).toBe(0);
    for (let i = 0; i < argv.length; i += 2) {
      expect(argv[i]).toBe("-u");
      expect(argv[i + 1]).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
  });

  test("an absent secrets file is not a crash — it yields an empty list", () => {
    const { argv } = scrub(join(tmpdir(), "fluncle-absent-secrets.env"), "--allow GH_TOKEN");
    expect(argv).toEqual([]);
  });
});
