import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const RUNNER = resolve(import.meta.dirname, "database-admission-runner.sh");
let directory: string;
let binDirectory: string;
let curlLog: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "fluncle-admission-runner-"));
  binDirectory = join(directory, "bin");
  curlLog = join(directory, "curl.log");
  mkdirSync(binDirectory);
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

function fakeCurl(body: string): void {
  fakeExecutable(
    "curl",
    `printf '%s\\n' "$*" >> "${curlLog}"
${body}`,
  );
}

function fakeExecutable(name: string, body: string): void {
  const source = `#!/usr/bin/env bash
${body}
`;
  const path = join(binDirectory, name);
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function run(
  command: string[],
  options: { failClosed?: boolean; maxWaitSecs?: number; token?: string } = {},
): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [RUNNER, "fluncle-enrich", "--", ...command], {
    encoding: "utf8",
    env: runnerEnvironment(options),
    timeout: 10_000,
  });
}

function runnerEnvironment(
  options: { failClosed?: boolean; maxWaitSecs?: number; token?: string } = {},
): NodeJS.ProcessEnv {
  const inheritedPath = process.env.PATH ?? "/usr/bin:/bin";
  return {
    DATABASE_ADMISSION_FAIL_CLOSED: options.failClosed === true ? "true" : "false",
    DATABASE_ADMISSION_HTTP_TIMEOUT_SECS: "1",
    DATABASE_ADMISSION_KILL_GRACE_SECS: "1",
    DATABASE_ADMISSION_MAX_WAIT_SECS: String(options.maxWaitSecs ?? 1),
    DATABASE_ADMISSION_POLL_SECS: "0",
    FLUNCLE_API_BASE_URL: "https://admission.invalid",
    FLUNCLE_API_TOKEN: options.token === undefined ? "test-token" : options.token,
    HOME: directory,
    PATH: `${binDirectory}:${inheritedPath}`,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for runner process state");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

function processIsExecuting(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  if (process.platform !== "linux") {
    return true;
  }

  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const stateOffset = stat.lastIndexOf(") ") + 2;
    if (stateOffset < 2) {
      return true;
    }

    // A container's PID 1 may leave a killed child as a zombie beyond this test's deadline.
    // Signal zero still succeeds for that PID even though the payload cannot execute.
    const state = stat[stateOffset];
    return state !== "X" && state !== "Z";
  } catch {
    return false;
  }
}

const SHADOW_RESPONSE = `echo '{"contenderId":"fluncle-enrich:run","enforced":false,"fencingToken":null,"heavyRead":false,"heartbeatAfterMs":30000,"holdMs":0,"lane":"write","leaseExpiresAtMs":null,"operationId":"track.enrich","outcome":"shadow-acquire","queueAgeMs":0,"recovered":false,"waitMs":0,"yieldReason":null}'`;
const ACQUIRED_RESPONSE = `echo '{"contenderId":"fluncle-enrich:run","enforced":true,"fencingToken":7,"heavyRead":false,"heartbeatAfterMs":1,"holdMs":0,"lane":"write","leaseExpiresAtMs":91000,"operationId":"track.enrich","outcome":"acquired","queueAgeMs":12,"recovered":false,"waitMs":12,"yieldReason":null}'`;
const QUEUED_RESPONSE = `echo '{"contenderId":"fluncle-enrich:run","enforced":true,"fencingToken":null,"heavyRead":false,"heartbeatAfterMs":30000,"holdMs":0,"lane":"write","leaseExpiresAtMs":null,"operationId":"track.enrich","outcome":"queued","queueAgeMs":12,"recovered":false,"waitMs":12,"yieldReason":"queue"}'`;

describe("database admission unit runner", () => {
  it("preserves old execution when shadow mode or the dark endpoint is unavailable", () => {
    fakeCurl(SHADOW_RESPONSE);
    const shadow = run(["bash", "-c", "printf shadow"]);
    expect(shadow.status).toBe(0);
    expect(shadow.stdout).toBe("shadow");

    const unavailable = run(["bash", "-c", "printf fallback"], { token: "" });
    expect(unavailable.status).toBe(0);
    expect(unavailable.stdout).toBe("fallback");
  });

  it("fails closed before payload start when the locally armed coordinator is unavailable", () => {
    const payloadMarker = join(directory, "payload-started");
    const result = run(["bash", "-c", `printf started > "${payloadMarker}"`], {
      failClosed: true,
      token: "",
    });

    expect(result.status).toBe(0);
    expect(existsSync(payloadMarker)).toBe(false);
    expect(result.stderr).toContain('"yield_reason":"coordinator-unavailable"');
  });

  it("fails closed before payload start while a locally armed unit still sees shadow mode", () => {
    fakeCurl(SHADOW_RESPONSE);
    const payloadMarker = join(directory, "payload-started");
    const result = run(["bash", "-c", `printf started > "${payloadMarker}"`], {
      failClosed: true,
    });

    expect(result.status).toBe(0);
    expect(existsSync(payloadMarker)).toBe(false);
    expect(result.stderr).toContain('"outcome":"enforcement-not-active"');
  });

  it("loads fail-closed readiness from the container secrets file before deriving config", () => {
    writeFileSync(join(directory, ".fluncle-secrets.env"), "DATABASE_ADMISSION_FAIL_CLOSED=true\n");
    fakeCurl(SHADOW_RESPONSE);
    const payloadMarker = join(directory, "payload-started");
    const result = run(["bash", "-c", `printf started > "${payloadMarker}"`]);

    expect(result.status).toBe(0);
    expect(existsSync(payloadMarker)).toBe(false);
    expect(result.stderr).toContain('"outcome":"enforcement-not-active"');
  });

  it("keeps enforcement sticky when a queued firing later receives a shadow response", () => {
    fakeCurl(`
if [ "$(wc -l < "${curlLog}")" -eq 1 ]; then
  ${QUEUED_RESPONSE}
else
  ${SHADOW_RESPONSE}
fi
`);
    const payloadMarker = join(directory, "payload-started");
    const result = run(["bash", "-c", `printf started > "${payloadMarker}"`]);

    expect(result.status).toBe(0);
    expect(existsSync(payloadMarker)).toBe(false);
    expect(result.stderr).toContain('"outcome":"enforcement-not-active"');
    expect(result.stderr).toContain('"enforced":true');
  });

  it("cancels a bounded queued acquisition without starting the payload", () => {
    fakeCurl(QUEUED_RESPONSE);
    const payloadMarker = join(directory, "payload-started");
    const result = run(["bash", "-c", `printf started > "${payloadMarker}"`], {
      maxWaitSecs: 0,
    });

    expect(result.status).toBe(0);
    expect(existsSync(payloadMarker)).toBe(false);
    expect(readFileSync(curlLog, "utf8")).toContain('"action":"cancel"');
    expect(result.stderr).toContain('"outcome":"wait-expired"');
  });

  it("releases a grant that arrives after the absolute acquisition deadline", () => {
    fakeCurl(`sleep 0.01
${ACQUIRED_RESPONSE}`);
    const payloadMarker = join(directory, "payload-started");
    const result = run(["bash", "-c", `printf started > "${payloadMarker}"`], {
      maxWaitSecs: 0,
    });

    expect(result.status).toBe(0);
    expect(existsSync(payloadMarker)).toBe(false);
    expect(readFileSync(curlLog, "utf8")).toContain('"action":"release"');
    expect(result.stderr).toContain('"outcome":"wait-expired"');
  });

  it("rejects acquisition waits longer than the committed service budget", () => {
    const result = run(["bash", "-c", "exit 0"], { maxWaitSecs: 121 });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("DATABASE_ADMISSION_MAX_WAIT_SECS must be between 0 and 120");
  });

  it("releases a completed payload with the exact fencing token", () => {
    fakeCurl(ACQUIRED_RESPONSE);
    const result = run(["bash", "-c", "printf complete"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("complete");
    const calls = readFileSync(curlLog, "utf8");
    expect(calls).toContain('"action":"acquire"');
    expect(calls).toContain('"action":"release"');
    expect(calls).toContain('"fencingToken":7');
    expect(result.stderr).toContain('"outcome":"released"');
    expect(result.stderr).toContain('"enforced":true');
    expect(result.stderr).toContain('"operation_id":"track.enrich"');
    expect(result.stderr).toContain('"run_id":"');
  });

  it("kills the payload process group and fails fenced when a heartbeat is partitioned", () => {
    fakeCurl(`
if printf '%s' "$*" | grep -q '"action":"heartbeat"'; then
  exit 1
fi
${ACQUIRED_RESPONSE}
`);
    const result = run(["bash", "-c", "while :; do sleep 1; done"]);

    expect(result.status).toBe(75);
    expect(result.signal).toBeNull();
    expect(result.stderr).toContain('"outcome":"fenced"');
    expect(result.stderr).toContain('"yield_reason":"partition"');
  });

  it("kills the payload process group when the heartbeat owner dies abruptly", async () => {
    fakeCurl(ACQUIRED_RESPONSE);
    const payloadMarker = join(directory, "payload-processes");
    const runner = spawn(
      "bash",
      [
        RUNNER,
        "fluncle-enrich",
        "--",
        "bash",
        "-c",
        'trap "" TERM; printf "%s:%s" "$PPID" "$$" > "$1"; while :; do sleep 1; done',
        "payload",
        payloadMarker,
      ],
      { env: runnerEnvironment(), stdio: "ignore" },
    );

    await waitUntil(() => existsSync(payloadMarker));
    const [groupText, payloadText] = readFileSync(payloadMarker, "utf8").split(":");
    const groupPid = Number(groupText);
    const payloadPid = Number(payloadText);
    expect(Number.isInteger(groupPid)).toBe(true);
    expect(Number.isInteger(payloadPid)).toBe(true);

    runner.kill("SIGKILL");
    try {
      await waitUntil(() => !processIsExecuting(payloadPid));
    } finally {
      try {
        process.kill(-groupPid, "SIGKILL");
      } catch {
        // The expected parent-death path already reaped the whole process group.
      }
    }
  });

  it("does not start the payload if the owner dies before parent-death arming completes", async () => {
    const setprivStarted = join(directory, "setpriv-started");
    const setprivFinished = join(directory, "setpriv-finished");
    fakeExecutable(
      "setpriv",
      `printf started > "${setprivStarted}"
sleep 1
shift 2
"$@"
printf finished > "${setprivFinished}"`,
    );
    fakeCurl(ACQUIRED_RESPONSE);
    const payloadMarker = join(directory, "payload-started");
    const runner = spawn(
      "bash",
      [RUNNER, "fluncle-enrich", "--", "bash", "-c", `printf started > "${payloadMarker}"`],
      { env: runnerEnvironment(), stdio: "ignore" },
    );

    await waitUntil(() => existsSync(setprivStarted));
    runner.kill("SIGKILL");
    await waitUntil(() => existsSync(setprivFinished));
    expect(existsSync(payloadMarker)).toBe(false);
  });

  it("fences a running payload when an enforced heartbeat downgrades to shadow", () => {
    fakeCurl(`
if printf '%s' "$*" | grep -q '"action":"heartbeat"'; then
  ${SHADOW_RESPONSE}
  exit 0
fi
${ACQUIRED_RESPONSE}
`);
    const result = run(["bash", "-c", "while :; do sleep 1; done"]);

    expect(result.status).toBe(75);
    expect(result.stderr).toContain('"yield_reason":"enforcement-not-active"');
  });

  it("releases the exact fencing token when a running unit is cancelled", () => {
    fakeCurl(ACQUIRED_RESPONSE);
    const result = run([
      "bash",
      "-c",
      'if [ -r "/proc/$PPID/stat" ]; then read -r group_pid group_comm group_state owner_pid group_rest < "/proc/$PPID/stat"; else read -r owner_pid < <(ps -o ppid= -p "$PPID"); fi; kill -TERM "$owner_pid"; while :; do sleep 1; done',
    ]);

    expect(result.status).toBe(143);
    const calls = readFileSync(curlLog, "utf8");
    expect(calls).toContain('"action":"release"');
    expect(calls).toContain('"fencingToken":7');
    expect(result.stderr).toContain('"outcome":"cancelled"');
  });
});
