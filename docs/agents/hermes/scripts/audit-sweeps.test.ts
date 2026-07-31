// Focused summary-contract tests for the two nightly audit shell drivers.
//
// These execute copies of the real scripts behind cron-output.sh. Every effectful command is a
// temp-PATH stub, the workspace is synthetic, and FLUNCLE_API_BASE_URL is explicitly empty, so
// the suite cannot reach git remotes, GitHub, Claude, a package registry, or the run ledger.
//
//   bun test docs/agents/hermes/scripts/audit-sweeps.test.ts

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AUDIT = join(import.meta.dir, "audit-sweep.sh");
const REVIEW = join(import.meta.dir, "audit-review-sweep.sh");
const AGENT_ENV = join(import.meta.dir, "agent-env.sh");
const CRON_OUTPUT = join(import.meta.dir, "cron-output.sh");

type Fixture = {
  bin: string;
  env: Record<string, string>;
  root: string;
  scripts: string;
  ws: string;
};

function executable(path: string, body: string): void {
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "fluncle-audit-summary-"));
  const scripts = join(root, "scripts");
  const bin = join(root, "bin");
  const ws = join(root, "workspace");
  const prompts = join(scripts, "audit", "prompts");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(ws, ".git"), { recursive: true });
  mkdirSync(prompts, { recursive: true });

  copyFileSync(AUDIT, join(scripts, "audit-sweep.sh"));
  copyFileSync(REVIEW, join(scripts, "audit-review-sweep.sh"));
  copyFileSync(AGENT_ENV, join(scripts, "agent-env.sh"));
  copyFileSync(CRON_OUTPUT, join(scripts, "cron-output.sh"));
  writeFileSync(join(prompts, "_preamble.md"), "# fixture audit\n", "utf8");
  writeFileSync(join(prompts, "_reviewer.md"), "# fixture review\n", "utf8");
  writeFileSync(join(prompts, "test.md"), "Inspect the fixture.\n", "utf8");

  executable(join(bin, "bun"), "#!/usr/bin/env bash\nexit 0\n");
  executable(join(bin, "claude"), '#!/usr/bin/env bash\nexit "${STUB_CLAUDE_STATUS:-0}"\n');
  executable(
    join(bin, "git"),
    `#!/usr/bin/env bash
case "$*" in
  *"status --porcelain"*)
    [ "\${STUB_CHANGED:-0}" = "0" ] || printf ' M fixture.txt\\n'
    ;;
  *"rev-list --count"*) printf '%s\\n' "\${STUB_AHEAD:-0}" ;;
esac
exit 0
`,
  );
  executable(
    join(bin, "gh"),
    `#!/usr/bin/env bash
case "$*" in
  *"pr list"*"--head"*) printf '%s\\n' "\${STUB_AUDIT_PR_URL:-}" ;;
  *"pr list"*) printf '%s\\n' "\${STUB_REVIEW_PR_NUM:-}" ;;
  *"pr checkout"*) exit "\${STUB_CHECKOUT_STATUS:-0}" ;;
  *"pr view"*"--json headRefName"*) printf 'audit/20260101-test\\n' ;;
  *"pr view"*"--json state"*) printf '%s\\n' "\${STUB_REVIEW_STATE:-OPEN}" ;;
esac
exit 0
`,
  );

  return {
    bin,
    env: {
      AUDIT_SECRETS_FILE: join(root, "absent-secrets.env"),
      AUDIT_WORKSPACE: ws,
      BUN_BIN: join(bin, "bun"),
      CLAUDE_CONFIG_DIR: join(root, "claude-config"),
      FLUNCLE_API_BASE_URL: "",
      FLUNCLE_AUDIT_GITHUB_PAT: "fixture-pat",
      HEALTHCHECK_CRON_OUTPUT_DIR: join(root, "cron-output"),
      HOME: join(root, "home"),
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    },
    root,
    scripts,
    ws,
  };
}

function run(
  box: Fixture,
  script: "audit-review-sweep.sh" | "audit-sweep.sh",
  args: string[],
  extraEnv: Record<string, string> = {},
): { status: number | null; summary: Record<string, unknown> } {
  const result = spawnSync("bash", [join(box.scripts, script), ...args], {
    encoding: "utf8",
    env: { ...box.env, ...extraEnv },
  });
  const line = (result.stdout ?? "")
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) {
    throw new Error(`no audit summary; stderr=${result.stderr}`);
  }
  return { status: result.status, summary: JSON.parse(line) as Record<string, unknown> };
}

describe("fluncle-audit canonical counters", () => {
  test("BLINDNESS: no readable domain is checked:0 and fails the detector", () => {
    const box = fixture();
    const result = run(box, "audit-sweep.sh", ["--domain", "missing"]);

    expect(result.status).toBe(1);
    expect(result.summary).toMatchObject({
      checked: 0,
      errors: 1,
      ok: false,
      produced: 0,
      stage: "domain",
    });
  });

  test("a clean audit looked at one domain and correctly produced nothing", () => {
    const box = fixture();
    const result = run(box, "audit-sweep.sh", ["--domain", "test"]);

    expect(result.status).toBe(0);
    expect(result.summary).toMatchObject({
      action: "clean",
      checked: 1,
      errors: 0,
      ok: true,
      produced: 0,
    });
    expect("queue_depth" in result.summary).toBe(false);
    expect("expected_interval_ms" in result.summary).toBe(false);
  });

  test("an opened PR is the one successfully acted-on audit unit", () => {
    const box = fixture();
    const result = run(box, "audit-sweep.sh", ["--domain", "test"], {
      STUB_AUDIT_PR_URL: "https://example.invalid/pull/1",
    });

    expect(result.summary).toMatchObject({ checked: 1, errors: 0, produced: 1 });
  });

  test("a failed dry-run agent cannot claim a changed path as produced", () => {
    const box = fixture();
    const result = run(box, "audit-sweep.sh", ["--domain", "test", "--dry-run"], {
      STUB_CHANGED: "1",
      STUB_CLAUDE_STATUS: "1",
    });

    expect(result.summary).toMatchObject({
      action: "dry-run",
      changed: 1,
      checked: 1,
      errors: 1,
      produced: 0,
    });
  });
});

describe("fluncle-audit-review canonical counters", () => {
  test("BLINDNESS: no audit PR to review is checked:0 and fails the detector", () => {
    const box = fixture();
    const result = run(box, "audit-review-sweep.sh", []);

    expect(result.status).toBe(1);
    expect(result.summary).toMatchObject({
      action: "none",
      checked: 0,
      errors: 1,
      ok: false,
      produced: 0,
    });
  });

  test("holding a reviewed PR is a successful review action", () => {
    const box = fixture();
    const result = run(box, "audit-review-sweep.sh", ["--pr", "7"]);

    expect(result.status).toBe(0);
    expect(result.summary).toMatchObject({
      action: "held",
      checked: 1,
      errors: 0,
      ok: true,
      produced: 1,
    });
    expect("queue_depth" in result.summary).toBe(false);
    expect("expected_interval_ms" in result.summary).toBe(false);
  });

  test("a selected PR still counts as checked when checkout fails", () => {
    const box = fixture();
    const result = run(box, "audit-review-sweep.sh", ["--pr", "7"], {
      STUB_CHECKOUT_STATUS: "1",
    });

    expect(result.summary).toMatchObject({
      checked: 1,
      errors: 1,
      produced: 0,
      stage: "checkout",
    });
  });

  test("an already-open PR does not prove reviewer action after claude fails", () => {
    const box = fixture();
    const result = run(box, "audit-review-sweep.sh", ["--pr", "7"], {
      STUB_CLAUDE_STATUS: "1",
    });

    expect(result.summary).toMatchObject({
      action: "held",
      checked: 1,
      errors: 1,
      produced: 0,
    });
  });
});
