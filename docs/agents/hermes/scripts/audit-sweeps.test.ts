// Focused summary-contract tests for the two nightly audit shell drivers.
//
// These execute copies of the real scripts behind cron-output.sh. Every effectful command is a
// temp-PATH stub, the workspace is synthetic, and FLUNCLE_API_BASE_URL is explicitly empty, so
// the suite cannot reach git remotes, GitHub, Claude, a package registry, or the run ledger.
//
//   bun test docs/agents/hermes/scripts/audit-sweeps.test.ts

import { afterEach, describe, expect, test as bunTest } from "bun:test";
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AUDIT = join(import.meta.dir, "audit-sweep.sh");
const REVIEW = join(import.meta.dir, "audit-review-sweep.sh");
const AGENT_ENV = join(import.meta.dir, "agent-env.sh");
const CRON_OUTPUT = join(import.meta.dir, "cron-output.sh");
const PROCESS_DEADLINE_MS = 20_000;
const PROCESS_TEST_BUDGET_MS = 30_000;
const PROCESS_CLEANUP_GRACE_MS = 1_000;
const PROCESS_OUTPUT_TAIL_CHARS = 64 * 1024;
const SCRIPT_PATH_EXPORT = 'export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"';
const temporaryDirectories: string[] = [];

function test(name: string, body: () => void | Promise<void>): void {
  bunTest(name, body, PROCESS_TEST_BUDGET_MS);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

type Fixture = {
  bin: string;
  env: Record<string, string>;
  root: string;
  scripts: string;
  ws: string;
};

type RunDeadlineOptions = {
  deadlineAfterStderr?: string;
  deadlineMs?: number;
  startupDeadlineMs?: number;
};

function executable(path: string, body: string): void {
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
}

function processGroupHasExecutingMembers(processGroupId: number): boolean {
  if (process.platform === "linux") {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) {
        continue;
      }
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const fieldsOffset = stat.lastIndexOf(") ") + 2;
        if (fieldsOffset < 2) {
          continue;
        }
        const fields = stat.slice(fieldsOffset).split(" ");
        const state = fields[0];
        const processGroup = Number(fields[2]);
        if (processGroup === processGroupId && state !== "X" && state !== "Z") {
          return true;
        }
      } catch {
        // The process exited between the directory and stat reads.
      }
    }
    return false;
  }

  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch {
    return false;
  }
}

async function processGroupHasNoExecutingMembers(processGroupId: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!processGroupHasExecutingMembers(processGroupId)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

function copyAuditScript(source: string, destination: string): void {
  const sourceText = readFileSync(source, "utf8");
  if (!sourceText.includes(SCRIPT_PATH_EXPORT)) {
    throw new Error(`audit fixture could not find the production PATH export in ${source}`);
  }
  const fixturePrelude = [
    SCRIPT_PATH_EXPORT,
    'export PATH="${FLUNCLE_AUDIT_TEST_STUB_BIN}:${PATH}"',
    "for command_name in git gh claude; do",
    '  resolved_command="$(command -v "${command_name}" || true)"',
    '  expected_command="${FLUNCLE_AUDIT_TEST_STUB_BIN}/${command_name}"',
    '  if [ "${resolved_command}" != "${expected_command}" ]; then',
    '    echo "audit fixture resolved ${command_name} to ${resolved_command:-<missing>}, expected ${expected_command}" >&2',
    "    exit 96",
    "  fi",
    "done",
    'if [ "${BUN_BIN}" != "${FLUNCLE_AUDIT_TEST_STUB_BIN}/bun" ]; then',
    '  echo "audit fixture resolved BUN_BIN to ${BUN_BIN}, expected ${FLUNCLE_AUDIT_TEST_STUB_BIN}/bun" >&2',
    "  exit 96",
    "fi",
    'if [ "${FLUNCLE_AUDIT_TEST_HANG:-0}" = "1" ]; then',
    "  trap '' TERM",
    "  (",
    "    trap '' TERM",
    '    exec sleep "${FLUNCLE_AUDIT_TEST_HANG_SECONDS:-60}"',
    "  ) &",
    '  echo "audit fixture entered the intentional process-group hang" >&2',
    "  wait",
    "fi",
  ].join("\n");
  writeFileSync(destination, sourceText.replace(SCRIPT_PATH_EXPORT, fixturePrelude), "utf8");
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "fluncle-audit-summary-"));
  temporaryDirectories.push(root);
  const scripts = join(root, "scripts");
  const bin = join(root, "bin");
  const temp = join(root, "tmp");
  const ws = join(root, "workspace");
  const prompts = join(scripts, "audit", "prompts");
  mkdirSync(bin, { recursive: true });
  mkdirSync(temp, { recursive: true });
  mkdirSync(join(ws, ".git"), { recursive: true });
  mkdirSync(prompts, { recursive: true });

  copyAuditScript(AUDIT, join(scripts, "audit-sweep.sh"));
  copyAuditScript(REVIEW, join(scripts, "audit-review-sweep.sh"));
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
      FLUNCLE_AUDIT_TEST_STUB_BIN: bin,
      HEALTHCHECK_CRON_OUTPUT_DIR: join(root, "cron-output"),
      HOME: join(root, "home"),
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      TMPDIR: temp,
    },
    root,
    scripts,
    ws,
  };
}

async function run(
  box: Fixture,
  script: "audit-review-sweep.sh" | "audit-sweep.sh",
  args: string[],
  extraEnv: Record<string, string> = {},
  deadlineOptions: RunDeadlineOptions = {},
): Promise<{ status: number | null; summary: Record<string, unknown> }> {
  const deadlineMs = deadlineOptions.deadlineMs ?? PROCESS_DEADLINE_MS;
  const child = spawn("bash", [join(box.scripts, script), ...args], {
    detached: true,
    env: { ...box.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  let stderrTruncated = false;
  let stdoutTruncated = false;
  let armDeadline = (): void => {};
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    if (stderr.length > PROCESS_OUTPUT_TAIL_CHARS) {
      stderr = stderr.slice(-PROCESS_OUTPUT_TAIL_CHARS);
      stderrTruncated = true;
    }
    if (
      deadlineOptions.deadlineAfterStderr !== undefined &&
      stderr.includes(deadlineOptions.deadlineAfterStderr)
    ) {
      armDeadline();
    }
  });
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (stdout.length > PROCESS_OUTPUT_TAIL_CHARS) {
      stdout = stdout.slice(-PROCESS_OUTPUT_TAIL_CHARS);
      stdoutTruncated = true;
    }
  });

  const result = await new Promise<{
    error: Error | null;
    signal: NodeJS.Signals | null;
    status: number | null;
    timedOutAfterMs: number | null;
  }>((resolve) => {
    let error: Error | null = null;
    let settled = false;
    let timedOutAfterMs: number | null = null;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (status: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
      }
      if (cleanupTimer !== undefined) {
        clearTimeout(cleanupTimer);
      }
      if (startupTimer !== undefined) {
        clearTimeout(startupTimer);
      }
      resolve({ error, signal, status, timedOutAfterMs });
    };
    const killProcessGroup = (): void => {
      const pid = child.pid;
      if (pid === undefined) {
        error = new Error("audit child has no process id");
        return;
      }
      try {
        process.kill(-pid, "SIGKILL");
      } catch (cause) {
        if ((cause as { code?: string }).code !== "ESRCH") {
          error = cause instanceof Error ? cause : new Error(String(cause));
          child.kill("SIGKILL");
        }
      }
    };
    const timeOut = (timeoutMs: number): void => {
      timedOutAfterMs = timeoutMs;
      killProcessGroup();
      cleanupTimer = setTimeout(() => {
        killProcessGroup();
        child.kill("SIGKILL");
        finish(child.exitCode, child.signalCode);
      }, PROCESS_CLEANUP_GRACE_MS);
    };
    armDeadline = () => {
      if (deadlineTimer !== undefined || timedOutAfterMs !== null) {
        return;
      }
      if (startupTimer !== undefined) {
        clearTimeout(startupTimer);
      }
      deadlineTimer = setTimeout(() => timeOut(deadlineMs), deadlineMs);
    };
    if (deadlineOptions.deadlineAfterStderr === undefined) {
      armDeadline();
    } else {
      const startupDeadlineMs = deadlineOptions.startupDeadlineMs ?? PROCESS_DEADLINE_MS;
      startupTimer = setTimeout(() => timeOut(startupDeadlineMs), startupDeadlineMs);
      if (stderr.includes(deadlineOptions.deadlineAfterStderr)) {
        armDeadline();
      }
    }
    child.once("error", (cause) => {
      error = cause;
      finish(child.exitCode, child.signalCode);
    });
    child.once("close", finish);
  });
  const diagnostics = [
    `error=${result.error ? `${result.error.name}: ${result.error.message}` : "<none>"}`,
    `status=${result.status ?? "null"}`,
    `signal=${result.signal ?? "null"}`,
    `stdout_tail${stdoutTruncated ? "(truncated)" : ""}=${JSON.stringify(stdout.trim() || "<empty>")}`,
    `stderr_tail${stderrTruncated ? "(truncated)" : ""}=${JSON.stringify(stderr.trim() || "<empty>")}`,
  ].join("; ");
  if (result.timedOutAfterMs !== null) {
    const deadlineError = new Error(
      `audit process exceeded ${result.timedOutAfterMs}ms deadline; ${diagnostics}`,
    ) as Error & { processGroupId?: number };
    deadlineError.processGroupId = child.pid;
    throw deadlineError;
  }
  if (result.error) {
    throw new Error(`audit process failed to start or stop; ${diagnostics}`);
  }
  const line = stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) {
    throw new Error(`no audit summary; ${diagnostics}`);
  }
  return { status: result.status, summary: JSON.parse(line) as Record<string, unknown> };
}

describe("fluncle-audit process bounds", () => {
  test("a hung TERM-resistant process group is killed at the fixture deadline", async () => {
    const box = fixture();
    let thrown: unknown;

    try {
      await run(
        box,
        "audit-sweep.sh",
        ["--domain", "test"],
        {
          FLUNCLE_AUDIT_TEST_HANG: "1",
        },
        {
          deadlineAfterStderr: "intentional process-group hang",
          deadlineMs: 500,
        },
      );
    } catch (cause) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      throw new Error("expected the hung audit fixture to exceed its process deadline");
    }
    expect(thrown.message).toContain("audit process exceeded 500ms deadline");
    expect(thrown.message).toContain("status=null");
    expect(thrown.message).toContain("signal=SIGKILL");
    expect(thrown.message).toContain("intentional process-group hang");

    const processGroupId = (thrown as Error & { processGroupId?: number }).processGroupId ?? 0;
    expect(Number.isSafeInteger(processGroupId)).toBe(true);
    expect(await processGroupHasNoExecutingMembers(processGroupId)).toBe(true);
  });
});

describe("fluncle-audit canonical counters", () => {
  test("BLINDNESS: no readable domain is checked:0 and fails the detector", async () => {
    const box = fixture();
    const result = await run(box, "audit-sweep.sh", ["--domain", "missing"]);

    expect(result.status).toBe(1);
    expect(result.summary).toMatchObject({
      checked: 0,
      errors: 1,
      ok: false,
      produced: 0,
      stage: "domain",
    });
  });

  test("a clean audit looked at one domain and correctly produced nothing", async () => {
    const box = fixture();
    const result = await run(box, "audit-sweep.sh", ["--domain", "test"]);

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

  test("an opened PR is the one successfully acted-on audit unit", async () => {
    const box = fixture();
    const result = await run(box, "audit-sweep.sh", ["--domain", "test"], {
      STUB_AUDIT_PR_URL: "https://example.invalid/pull/1",
    });

    expect(result.summary).toMatchObject({ checked: 1, errors: 0, produced: 1 });
  });

  test("a failed dry-run agent cannot claim a changed path as produced", async () => {
    const box = fixture();
    const result = await run(box, "audit-sweep.sh", ["--domain", "test", "--dry-run"], {
      STUB_CHANGED: "1",
      STUB_CLAUDE_STATUS: "1",
    });

    expect(result.summary).toMatchObject({
      action: "dry-run",
      changed: 1,
      checked: 1,
      errors: 1,
      ok: false,
      produced: 0,
    });
  });

  // `ok` is DERIVED from the error count, never a literal — the ledger's own rule
  // (exit 0 AND errors 0). These three pin every branch that carries a live `run_errors`, because
  // the defect they exist to catch is per-branch: the sweep printed `{"ok":true,…,"errors":1}` on
  // the `clean` branch on production while /status read the literal and called it healthy.
  test("a nonzero agent contradicts the literal: an errored clean night is ok:false", async () => {
    const box = fixture();
    const result = await run(box, "audit-sweep.sh", ["--domain", "test"], {
      STUB_CLAUDE_STATUS: "1",
    });

    expect(result.summary).toMatchObject({
      action: "clean",
      checked: 1,
      errors: 1,
      ok: false,
      produced: 0,
    });
  });

  test("an opened PR is still ok:false when the agent that opened it errored", async () => {
    const box = fixture();
    const result = await run(box, "audit-sweep.sh", ["--domain", "test"], {
      STUB_AUDIT_PR_URL: "https://example.invalid/pull/1",
      STUB_CLAUDE_STATUS: "1",
    });

    expect(result.summary).toMatchObject({ action: "opened", errors: 1, ok: false });
  });

  test("the healthy dry-run path still reports ok:true", async () => {
    const box = fixture();
    const result = await run(box, "audit-sweep.sh", ["--domain", "test", "--dry-run"], {
      STUB_CHANGED: "1",
    });

    expect(result.status).toBe(0);
    expect(result.summary).toMatchObject({
      action: "dry-run",
      changed: 1,
      checked: 1,
      errors: 0,
      ok: true,
      produced: 1,
    });
  });
});

describe("fluncle-audit-review canonical counters", () => {
  test("an empty review queue exits cleanly without checking or producing work", async () => {
    const box = fixture();
    const result = await run(box, "audit-review-sweep.sh", []);

    expect(result.status).toBe(0);
    expect(result.summary).toMatchObject({
      action: "none",
      checked: 0,
      errors: 0,
      ok: true,
      produced: 0,
    });
    expect("queue_depth" in result.summary).toBe(false);
    expect("expected_interval_ms" in result.summary).toBe(false);
  });

  test("holding a reviewed PR is a successful review action", async () => {
    const box = fixture();
    const result = await run(box, "audit-review-sweep.sh", ["--pr", "7"]);

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

  test("a selected PR still counts as checked when checkout fails", async () => {
    const box = fixture();
    const result = await run(box, "audit-review-sweep.sh", ["--pr", "7"], {
      STUB_CHECKOUT_STATUS: "1",
    });

    expect(result.summary).toMatchObject({
      checked: 1,
      errors: 1,
      produced: 0,
      stage: "checkout",
    });
  });

  test("an already-open PR does not prove reviewer action after claude fails", async () => {
    const box = fixture();
    const result = await run(box, "audit-review-sweep.sh", ["--pr", "7"], {
      STUB_CLAUDE_STATUS: "1",
    });

    expect(result.summary).toMatchObject({
      action: "held",
      checked: 1,
      errors: 1,
      ok: false,
      produced: 0,
    });
  });

  test("a merged PR is ok:false when the reviewer that merged it errored", async () => {
    const box = fixture();
    const result = await run(box, "audit-review-sweep.sh", ["--pr", "7"], {
      STUB_CLAUDE_STATUS: "1",
      STUB_REVIEW_STATE: "MERGED",
    });

    expect(result.summary).toMatchObject({ action: "merged", errors: 1, ok: false });
  });

  test("a merged PR the reviewer handled cleanly still reports ok:true", async () => {
    const box = fixture();
    const result = await run(box, "audit-review-sweep.sh", ["--pr", "7"], {
      STUB_REVIEW_STATE: "MERGED",
    });

    expect(result.status).toBe(0);
    expect(result.summary).toMatchObject({
      action: "merged",
      checked: 1,
      errors: 0,
      ok: true,
      produced: 1,
    });
  });
});
