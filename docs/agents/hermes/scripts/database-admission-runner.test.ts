import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const RUNNER = resolve(import.meta.dirname, "database-admission-runner.sh");
const CRON_OUTPUT = resolve(import.meta.dirname, "cron-output.sh");
// Shell startup and marker emission are integration work, not a five-second performance SLA.
// Keep the inner deadlines below the outer test budget so failures retain their diagnostics
// and cleanup can finish before the test runner abandons the fixture.
const PROCESS_TEST_TIMEOUT_MS = 40_000;
const RUN_TIMEOUT_MS = 20_000;
const PROCESS_STATE_TIMEOUT_MS = 15_000;
const PROCESS_EXIT_TIMEOUT_MS = 15_000;
const PROCESS_CLEANUP_TIMEOUT_MS = 5_000;
const PROCESS_TEST_OPTIONS = { timeout: PROCESS_TEST_TIMEOUT_MS };
let directory: string;
let binDirectory: string;
let curlLog: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "fluncle-admission-runner-"));
  binDirectory = join(directory, "bin");
  curlLog = join(directory, "curl.log");
  mkdirSync(binDirectory);

  if (process.platform === "darwin") {
    fakeExecutable(
      "setsid",
      `exec perl -MPOSIX=setsid -e 'setsid() >= 0 or die "setsid: $!"; exec @ARGV or die "exec: $!"' -- "$@"`,
    );
    fakeExecutable(
      "setpriv",
      `shift 2
exec "$@"`,
    );
  }

  fakeExecutable(
    "process-is-executing",
    `pid="$1"
if [ -r "/proc/$pid/stat" ]; then
  stat="$(cat "/proc/$pid/stat")" || exit 1
  state="\${stat##*) }"
  state="\${state%% *}"
  [ "$state" != "X" ] && [ "$state" != "Z" ]
else
  kill -0 "$pid" 2>/dev/null
fi`,
  );
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

async function run(
  command: string[],
  options: { failClosed?: boolean; home?: string; maxWaitSecs?: number; token?: string } = {},
  timeoutMs = RUN_TIMEOUT_MS,
): Promise<{
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn("bash", [RUNNER, "fluncle-enrich", "--", ...command], {
    detached: true,
    env: runnerEnvironment(options),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout = (stdout + chunk.toString()).slice(-65_536);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-65_536);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Wait for pipe closure too: a surviving fixture descendant must not hold up the suite.
    const outcome = await new Promise<ProcessOutcome>((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("close", (code, signal) => resolvePromise({ code, signal }));
      timer = setTimeout(() => rejectPromise(new Error("process deadline exceeded")), timeoutMs);
    });
    return { signal: outcome.signal, status: outcome.code, stderr, stdout };
  } catch (error) {
    // TERM is handled by the runner and can wait on the fake coordinator. Kill the isolated
    // fixture group, including any coordinator child still holding stdout/stderr open.
    if (child.pid !== undefined) {
      await stopProcessGroup(child.pid);
    }
    await stopSpawnedProcess(child);
    throw new Error(
      `admission fixture failed; deadline=${timeoutMs}ms status=${child.exitCode} signal=${child.signalCode}; stdout=${stdout}; stderr=${stderr}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

function runnerEnvironment(
  options: { failClosed?: boolean; home?: string; maxWaitSecs?: number; token?: string } = {},
): NodeJS.ProcessEnv {
  const inheritedPath = process.env.PATH ?? "/usr/bin:/bin";
  const home = options.home ?? directory;
  return {
    DATABASE_ADMISSION_FAIL_CLOSED: options.failClosed === true ? "true" : "false",
    DATABASE_ADMISSION_HTTP_TIMEOUT_SECS: "1",
    DATABASE_ADMISSION_KILL_GRACE_SECS: "1",
    DATABASE_ADMISSION_MAX_WAIT_SECS: String(options.maxWaitSecs ?? 1),
    DATABASE_ADMISSION_POLL_SECS: "0",
    FLUNCLE_API_BASE_URL: "https://admission.invalid",
    FLUNCLE_API_TOKEN: options.token === undefined ? "test-token" : options.token,
    HEALTHCHECK_CRON_OUTPUT_DIR: join(directory, "cron-output"),
    HOME: home,
    PATH: `${binDirectory}:${inheritedPath}`,
  };
}

function liveRebakeHome(): string {
  const home = join(directory, "home");
  mkdirSync(home);
  writeFileSync(join(directory, "rebake.lock"), "live rebake\n");
  return home;
}

function markerSummary(): Record<string, unknown> {
  const markerDirectory = join(directory, "cron-output", "fluncle-enrich");
  const marker = readdirSync(markerDirectory)
    .filter((entry) => entry.endsWith(".md"))
    .sort()
    .at(-1);

  expect(marker).toBeTruthy();
  const body = readFileSync(join(markerDirectory, marker ?? ""), "utf8");
  const summary = body
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .at(-1);

  expect(summary).toBeTruthy();
  return JSON.parse(summary ?? "{}") as Record<string, unknown>;
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = PROCESS_STATE_TIMEOUT_MS,
  description = "runner process state",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

type ProcessOutcome = { code: number | null; signal: NodeJS.Signals | null };

function waitForExit(
  child: ChildProcess,
  timeoutMs = PROCESS_EXIT_TIMEOUT_MS,
): Promise<ProcessOutcome> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      rejectPromise(new Error(`timed out after ${timeoutMs}ms waiting for child process exit`));
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function stopSpawnedProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGKILL");
  await waitForExit(child, PROCESS_CLEANUP_TIMEOUT_MS);
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

function processGroupHasExecutingMembers(groupPid: number): boolean {
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
        if (processGroup === groupPid && state !== "X" && state !== "Z") {
          return true;
        }
      } catch {
        // The process exited between the directory and stat reads.
      }
    }
    return false;
  }

  try {
    process.kill(-groupPid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopProcessGroup(groupPid: number): Promise<void> {
  if (!Number.isInteger(groupPid) || groupPid <= 0) {
    throw new Error(`refusing to stop invalid process group ${groupPid}`);
  }
  if (!processGroupHasExecutingMembers(groupPid)) {
    return;
  }

  try {
    process.kill(-groupPid, "SIGKILL");
  } catch {
    if (processGroupHasExecutingMembers(groupPid)) {
      throw new Error(`failed to signal process group ${groupPid}`);
    }
    return;
  }
  await waitUntil(
    () => !processGroupHasExecutingMembers(groupPid),
    PROCESS_CLEANUP_TIMEOUT_MS,
    `process group ${groupPid} cleanup`,
  );
}

const SHADOW_RESPONSE = `echo '{"contenderId":"fluncle-enrich:run","enforced":false,"fencingToken":null,"heavyRead":false,"heartbeatAfterMs":30000,"holdMs":0,"lane":"write","leaseExpiresAtMs":null,"operationId":"track.enrich","outcome":"shadow-acquire","queueAgeMs":0,"recovered":false,"waitMs":0,"yieldReason":null}'`;
const ACQUIRED_RESPONSE = `echo '{"contenderId":"fluncle-enrich:run","enforced":true,"fencingToken":7,"heavyRead":false,"heartbeatAfterMs":1,"holdMs":0,"lane":"write","leaseExpiresAtMs":91000,"operationId":"track.enrich","outcome":"acquired","queueAgeMs":12,"recovered":false,"waitMs":12,"yieldReason":null}'`;
const QUEUED_RESPONSE = `echo '{"contenderId":"fluncle-enrich:run","enforced":true,"fencingToken":null,"heavyRead":false,"heartbeatAfterMs":30000,"holdMs":0,"lane":"write","leaseExpiresAtMs":null,"operationId":"track.enrich","outcome":"queued","queueAgeMs":12,"recovered":false,"waitMs":12,"yieldReason":"queue"}'`;
const MALFORMED_YIELD_QUEUED_RESPONSE = `echo '{"contenderId":"fluncle-enrich:run","enforced":true,"fencingToken":null,"heavyRead":false,"heartbeatAfterMs":30000,"holdMs":0,"lane":"write","leaseExpiresAtMs":null,"operationId":"track.enrich","outcome":"queued","queueAgeMs":12,"recovered":false,"waitMs":12,"yieldReason":"queue\\\\malformed"}'`;

describe("database admission unit runner", () => {
  it(
    "hard-stops a hung fixture instead of waiting for its TERM handler",
    PROCESS_TEST_OPTIONS,
    async () => {
      await expect(
        run(["bash", "-c", 'trap "" TERM; exec sleep 30'], { token: "" }, 250),
      ).rejects.toThrow(/deadline=250ms.*signal=SIGKILL/);
    },
  );

  it(
    "allows a slow fixture response without weakening the shadow behavior assertion",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeCurl(`sleep 5.1\n${SHADOW_RESPONSE}`);
      const result = await run(["bash", "-c", "printf shadow"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("shadow");
      expect(result.stderr).toContain('"outcome":"shadow"');
    },
  );

  it(
    "preserves old execution when shadow mode or the dark endpoint is unavailable",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeCurl(SHADOW_RESPONSE);
      const shadow = await run(["bash", "-c", "printf shadow"]);
      expect(shadow.status).toBe(0);
      expect(shadow.stdout).toBe("shadow");

      const unavailable = await run(["bash", "-c", "printf fallback"], { token: "" });
      expect(unavailable.status).toBe(0);
      expect(unavailable.stdout).toBe("fallback");
    },
  );

  it(
    "fails closed before payload start when the locally armed coordinator is unavailable",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeCurl(`
if printf '%s' "$*" | grep -q '"action":"acquire"'; then
  exit 1
fi
printf '{}'
`);
      const payloadMarker = join(directory, "payload-started");
      const result = await run(["bash", "-c", `printf started > "${payloadMarker}"`], {
        failClosed: true,
      });

      expect(result.status).toBe(0);
      expect(existsSync(payloadMarker)).toBe(false);
      expect(result.stderr).toContain('"yield_reason":"coordinator-unavailable"');
      expect(markerSummary()).toEqual({
        admissionOutcome: "acquisition-unavailable",
        admissionWaitMs: 0,
        admissionYieldReason: "coordinator-unavailable",
        checked: null,
        errors: 0,
        expectedIntervalMs: null,
        gateState: "admission-skipped",
        payloadStarted: false,
        produced: null,
        queueDepth: null,
      });
      // The same wrapper POSTs the marker's summary to the ledger; the fake coordinator lets
      // that separate endpoint succeed, so this firing is evidence rather than journald-only.
      expect(readFileSync(curlLog, "utf8")).toContain('"summary_raw"');
    },
  );

  it("cancels once when signals race an in-flight acquisition", PROCESS_TEST_OPTIONS, async () => {
    const acquireStarted = join(directory, "acquire-started");
    const finishAcquire = join(directory, "finish-acquire");
    const payloadMarker = join(directory, "payload-started");
    fakeCurl(`
if printf '%s' "$*" | grep -q '"action":"acquire"'; then
  printf started > "${acquireStarted}"
  while [ ! -e "${finishAcquire}" ]; do sleep 0.01; done
  exit 1
fi
echo '{}'
`);
    const runner = spawn(
      "bash",
      [RUNNER, "fluncle-enrich", "--", "bash", "-c", `printf started > "${payloadMarker}"`],
      {
        env: runnerEnvironment({ failClosed: true }),
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    runner.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8_192);
    });

    try {
      await waitUntil(() => existsSync(acquireStarted), undefined, "acquisition handshake");
      expect(existsSync(payloadMarker)).toBe(false);
      expect(readFileSync(curlLog, "utf8").match(/"action":"cancel"/g)?.length ?? 0).toBe(0);

      runner.kill("SIGTERM");
      runner.kill("SIGINT");
      runner.kill("SIGHUP");
      writeFileSync(finishAcquire, "finish\n");
      const outcome = await waitForExit(runner);

      expect(outcome.code).toBe(143);
      expect(outcome.signal).toBeNull();
      expect(existsSync(payloadMarker)).toBe(false);
      const calls = readFileSync(curlLog, "utf8");
      expect(calls.match(/"action":"cancel"/g)?.length ?? 0).toBe(1);
    } catch (error) {
      const calls = existsSync(curlLog) ? readFileSync(curlLog, "utf8") : "no coordinator calls";
      throw new Error(
        `acquisition signal fixture: ${String(error)}; calls=${calls}; stderr=${stderr}`,
        {
          cause: error,
        },
      );
    } finally {
      writeFileSync(finishAcquire, "finish\n");
      await stopSpawnedProcess(runner);
    }
  });

  it(
    "fails closed before payload start while a locally armed unit still sees shadow mode",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeCurl(SHADOW_RESPONSE);
      const payloadMarker = join(directory, "payload-started");
      const result = await run(["bash", "-c", `printf started > "${payloadMarker}"`], {
        failClosed: true,
      });

      expect(result.status).toBe(0);
      expect(existsSync(payloadMarker)).toBe(false);
      expect(result.stderr).toContain('"outcome":"enforcement-not-active"');
    },
  );

  it(
    "loads fail-closed readiness from the container secrets file before deriving config",
    PROCESS_TEST_OPTIONS,
    async () => {
      writeFileSync(
        join(directory, ".fluncle-secrets.env"),
        "DATABASE_ADMISSION_FAIL_CLOSED=true\n",
      );
      fakeCurl(SHADOW_RESPONSE);
      const payloadMarker = join(directory, "payload-started");
      const result = await run(["bash", "-c", `printf started > "${payloadMarker}"`]);

      expect(result.status).toBe(0);
      expect(existsSync(payloadMarker)).toBe(false);
      expect(result.stderr).toContain('"outcome":"enforcement-not-active"');
    },
  );

  it(
    "keeps enforcement sticky when a queued firing later receives a shadow response",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeCurl(`
if [ "$(wc -l < "${curlLog}")" -eq 1 ]; then
  ${QUEUED_RESPONSE}
else
  ${SHADOW_RESPONSE}
fi
`);
      const payloadMarker = join(directory, "payload-started");
      const result = await run(["bash", "-c", `printf started > "${payloadMarker}"`]);

      expect(result.status).toBe(0);
      expect(existsSync(payloadMarker)).toBe(false);
      expect(result.stderr).toContain('"outcome":"enforcement-not-active"');
      expect(result.stderr).toContain('"enforced":true');
    },
  );

  it(
    "cancels a bounded queued acquisition without starting the payload",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeCurl(QUEUED_RESPONSE);
      const payloadMarker = join(directory, "payload-started");
      const result = await run(["bash", "-c", `printf started > "${payloadMarker}"`], {
        maxWaitSecs: 0,
      });

      expect(result.status).toBe(0);
      expect(existsSync(payloadMarker)).toBe(false);
      expect(readFileSync(curlLog, "utf8")).toContain('"action":"cancel"');
      expect(result.stderr).toContain('"outcome":"wait-expired"');
      expect(markerSummary()).toEqual({
        admissionOutcome: "wait-expired",
        admissionWaitMs: 12,
        admissionYieldReason: "queue",
        checked: null,
        errors: 0,
        expectedIntervalMs: null,
        gateState: "admission-skipped",
        payloadStarted: false,
        produced: null,
        queueDepth: null,
      });
    },
  );

  it(
    "reports one admission skip through a live rebake lock and cancels its queued lease",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeCurl(QUEUED_RESPONSE);
      const payloadMarker = join(directory, "payload-started");
      const result = await run(["bash", "-c", `printf started > "${payloadMarker}"`], {
        home: liveRebakeHome(),
        maxWaitSecs: 0,
      });

      expect(result.status).toBe(0);
      expect(existsSync(payloadMarker)).toBe(false);
      expect(markerSummary()).toMatchObject({
        admissionOutcome: "wait-expired",
        gateState: "admission-skipped",
        payloadStarted: false,
      });
      expect(readdirSync(join(directory, "cron-output", "fluncle-enrich"))).toHaveLength(1);
      const calls = readFileSync(curlLog, "utf8");
      expect(calls.match(/"action":"cancel"/g)?.length ?? 0).toBe(1);
      expect(calls.match(/"summary_raw"/g)?.length ?? 0).toBe(1);
    },
  );

  it(
    "reports one admission skip through a live rebake lock and releases a late grant",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeCurl(`sleep 0.01
${ACQUIRED_RESPONSE}`);
      const payloadMarker = join(directory, "payload-started");
      const result = await run(["bash", "-c", `printf started > "${payloadMarker}"`], {
        home: liveRebakeHome(),
        maxWaitSecs: 0,
      });

      expect(result.status).toBe(0);
      expect(existsSync(payloadMarker)).toBe(false);
      expect(markerSummary()).toMatchObject({
        admissionOutcome: "wait-expired",
        gateState: "admission-skipped",
        payloadStarted: false,
      });
      expect(readdirSync(join(directory, "cron-output", "fluncle-enrich"))).toHaveLength(1);
      const calls = readFileSync(curlLog, "utf8");
      expect(calls.match(/"action":"release"/g)?.length ?? 0).toBe(1);
      expect(calls.match(/"summary_raw"/g)?.length ?? 0).toBe(1);
    },
  );

  it(
    "keeps a malformed coordinator yield reason out of the marker JSON",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeCurl(MALFORMED_YIELD_QUEUED_RESPONSE);
      const payloadMarker = join(directory, "payload-started");
      const result = await run(["bash", "-c", `printf started > "${payloadMarker}"`], {
        maxWaitSecs: 0,
      });

      expect(result.status).toBe(0);
      expect(existsSync(payloadMarker)).toBe(false);
      expect(markerSummary()).toMatchObject({
        admissionOutcome: "wait-expired",
        admissionYieldReason: "queue",
        payloadStarted: false,
      });
    },
  );

  it(
    "releases a grant that arrives after the absolute acquisition deadline",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeCurl(`sleep 0.01
${ACQUIRED_RESPONSE}`);
      const payloadMarker = join(directory, "payload-started");
      const result = await run(["bash", "-c", `printf started > "${payloadMarker}"`], {
        maxWaitSecs: 0,
      });

      expect(result.status).toBe(0);
      expect(existsSync(payloadMarker)).toBe(false);
      expect(readFileSync(curlLog, "utf8")).toContain('"action":"release"');
      expect(result.stderr).toContain('"outcome":"wait-expired"');
    },
  );

  it(
    "rejects acquisition waits longer than the committed service budget",
    PROCESS_TEST_OPTIONS,
    async () => {
      const result = await run(["bash", "-c", "exit 0"], { maxWaitSecs: 121 });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("DATABASE_ADMISSION_MAX_WAIT_SECS must be between 0 and 120");
    },
  );

  it(
    "releases a completed payload with the exact fencing token",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeCurl(ACQUIRED_RESPONSE);
      const result = await run(["bash", "-c", "printf complete"]);

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
    },
  );

  it("leaves an acquired payload's own success evidence intact", PROCESS_TEST_OPTIONS, async () => {
    fakeCurl(ACQUIRED_RESPONSE);
    const result = await run([
      "bash",
      "-c",
      'source "$1"; emit_cron_output enrich -- bash -c \'printf "{\\\"checked\\\":1,\\\"errors\\\":0,\\\"produced\\\":1,\\\"queueDepth\\\":0}\\n"\'',
      "payload",
      CRON_OUTPUT,
    ]);

    expect(result.status).toBe(0);
    expect(markerSummary()).toEqual({ checked: 1, errors: 0, produced: 1, queueDepth: 0 });
    expect(result.stdout).toContain('"produced":1');
    expect(result.stderr).toContain('"outcome":"released"');
  });

  it(
    "uses the in-group owner watcher when parent-death signaling is unavailable",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeExecutable("setpriv", "exit 1");
      fakeCurl(ACQUIRED_RESPONSE);
      const result = await run(["bash", "-c", "printf fallback"]);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("fallback");
      expect(result.stderr).toContain('"outcome":"released"');
      expect(result.stderr).toContain('"enforced":true');
    },
  );

  it(
    "kills an in-session descendant before releasing a completed payload",
    PROCESS_TEST_OPTIONS,
    async () => {
      const descendantMarker = join(directory, "residual-descendant");
      const releaseObservation = join(directory, "release-observation");
      fakeCurl(`
if printf '%s' "$*" | grep -q '"action":"release"'; then
  descendant_pid="$(cat "${descendantMarker}")"
  if process-is-executing "$descendant_pid"; then
    printf alive > "${releaseObservation}"
  else
    printf gone > "${releaseObservation}"
  fi
fi
${ACQUIRED_RESPONSE}
`);
      const result = await run([
        "bash",
        "-c",
        `(
        trap "" TERM HUP
        while :; do sleep 1; done
      ) &
      printf "%s" "$!" > "$1"
      while [ ! -s "$1" ]; do sleep 0.01; done`,
        "payload",
        descendantMarker,
      ]);

      expect(result.status).toBe(0);
      expect(readFileSync(releaseObservation, "utf8")).toBe("gone");
      const calls = readFileSync(curlLog, "utf8");
      expect(calls.match(/"action":"release"/g)?.length ?? 0).toBe(1);
    },
  );

  it(
    "kills residual group work and releases once when the supervisor dies",
    PROCESS_TEST_OPTIONS,
    async () => {
      const descendantMarker = join(directory, "orphaned-descendant");
      const releaseObservation = join(directory, "orphan-release-observation");
      fakeCurl(`
if printf '%s' "$*" | grep -q '"action":"release"'; then
  descendant_pid="$(cat "${descendantMarker}")"
  if process-is-executing "$descendant_pid"; then
    printf alive > "${releaseObservation}"
  else
    printf gone > "${releaseObservation}"
  fi
fi
${ACQUIRED_RESPONSE}
`);
      const result = await run([
        "bash",
        "-c",
        `(
        trap "" TERM HUP
        while :; do sleep 1; done
      ) &
      printf "%s" "$!" > "$1"
      while [ ! -s "$1" ]; do sleep 0.01; done
      kill -KILL "$PPID"
      while :; do sleep 1; done`,
        "payload",
        descendantMarker,
      ]);

      expect(result.status).toBe(137);
      expect(readFileSync(releaseObservation, "utf8")).toBe("gone");
      const calls = readFileSync(curlLog, "utf8");
      expect(calls.match(/"action":"release"/g)?.length ?? 0).toBe(1);
    },
  );

  it(
    "kills the payload process group and fails fenced when a heartbeat is partitioned",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeCurl(`
if printf '%s' "$*" | grep -q '"action":"heartbeat"'; then
  exit 1
fi
${ACQUIRED_RESPONSE}
`);
      const result = await run(["bash", "-c", "while :; do sleep 1; done"]);
      expect(result.status).toBe(75);
      expect(result.signal).toBeNull();
      expect(result.stderr).toContain('"outcome":"fenced"');
      expect(result.stderr).toContain('"yield_reason":"partition"');
    },
  );

  it(
    "kills the payload process group when the heartbeat owner dies abruptly",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeCurl(ACQUIRED_RESPONSE);
      const payloadMarker = join(directory, "payload-processes");
      let groupPid: number | undefined;
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

      try {
        await waitUntil(() => existsSync(payloadMarker), undefined, "payload readiness handshake");
        const [groupText, payloadText] = readFileSync(payloadMarker, "utf8").split(":");
        groupPid = Number(groupText);
        const payloadPid = Number(payloadText);
        expect(Number.isInteger(groupPid) && groupPid > 0).toBe(true);
        expect(Number.isInteger(payloadPid) && payloadPid > 0).toBe(true);

        runner.kill("SIGKILL");
        const [outcome] = await Promise.all([
          waitForExit(runner),
          waitUntil(
            () => !processIsExecuting(payloadPid),
            PROCESS_STATE_TIMEOUT_MS,
            "parent-death payload cleanup",
          ),
        ]);
        expect(outcome.code).toBeNull();
        expect(outcome.signal).toBe("SIGKILL");
      } finally {
        await stopSpawnedProcess(runner);
        if (groupPid !== undefined) {
          await stopProcessGroup(groupPid);
        }
      }
    },
  );

  it(
    "does not start the payload if the owner dies before parent-death arming completes",
    PROCESS_TEST_OPTIONS,
    async () => {
      const setprivStarted = join(directory, "setpriv-started");
      const finishSetpriv = join(directory, "finish-setpriv");
      const setprivExecStarted = join(directory, "setpriv-exec-started");
      fakeExecutable(
        "setpriv",
        `if [ "$#" -eq 3 ] && [ "$1" = "--pdeathsig" ] && [ "$2" = "TERM" ] && [ "$3" = "true" ]; then
  exit 0
fi
printf '%s' "$$" > "${setprivStarted}"
while [ ! -e "${finishSetpriv}" ]; do sleep 0.01; done
shift 2
printf exec > "${setprivExecStarted}"
exec "$@"`,
      );
      fakeCurl(ACQUIRED_RESPONSE);
      const payloadMarker = join(directory, "payload-started");
      let setprivPid: number | undefined;
      const runner = spawn(
        "bash",
        [RUNNER, "fluncle-enrich", "--", "bash", "-c", `printf started > "${payloadMarker}"`],
        { env: runnerEnvironment(), stdio: "ignore" },
      );

      try {
        await waitUntil(() => existsSync(setprivStarted), undefined, "setpriv payload handshake");
        const armedGroupPid = Number(readFileSync(setprivStarted, "utf8"));
        expect(Number.isInteger(armedGroupPid) && armedGroupPid > 0).toBe(true);
        setprivPid = armedGroupPid;

        runner.kill("SIGKILL");
        const outcome = await waitForExit(runner);
        expect(outcome.code).toBeNull();
        expect(outcome.signal).toBe("SIGKILL");
        writeFileSync(finishSetpriv, "finish\n");
        await waitUntil(
          () => existsSync(setprivExecStarted) && !processGroupHasExecutingMembers(armedGroupPid),
          PROCESS_STATE_TIMEOUT_MS,
          "pre-arm process-group cleanup",
        );
        expect(existsSync(payloadMarker)).toBe(false);
      } finally {
        writeFileSync(finishSetpriv, "finish\n");
        await stopSpawnedProcess(runner);
        if (setprivPid !== undefined) {
          await stopProcessGroup(setprivPid);
        }
      }
    },
  );

  it(
    "fences a running payload when an enforced heartbeat downgrades to shadow",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeCurl(`
if printf '%s' "$*" | grep -q '"action":"heartbeat"'; then
  ${SHADOW_RESPONSE}
  exit 0
fi
${ACQUIRED_RESPONSE}
`);
      const result = await run(["bash", "-c", "while :; do sleep 1; done"]);
      expect(result.status).toBe(75);
      expect(result.stderr).toContain('"yield_reason":"enforcement-not-active"');
    },
  );

  it(
    "releases the exact fencing token when a running unit is cancelled",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeCurl(ACQUIRED_RESPONSE);
      const result = await run([
        "bash",
        "-c",
        'kill -TERM "$FLUNCLE_ADMISSION_RUNNER_PID"; kill -INT "$FLUNCLE_ADMISSION_RUNNER_PID" 2>/dev/null || true; kill -HUP "$FLUNCLE_ADMISSION_RUNNER_PID" 2>/dev/null || true; while :; do sleep 1; done',
      ]);

      expect(result.status).toBe(143);
      const calls = readFileSync(curlLog, "utf8");
      expect(calls).toContain('"action":"release"');
      expect(calls).toContain('"fencingToken":7');
      expect(calls.match(/"action":"release"/g)?.length ?? 0).toBe(1);
      expect(result.stderr).toContain('"outcome":"cancelled"');
    },
  );
});
