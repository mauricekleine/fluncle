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
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const RUNNER = resolve(import.meta.dirname, "database-admission-runner.sh");
const CRON_OUTPUT = resolve(import.meta.dirname, "cron-output.sh");

const PROCESS_TEST_TIMEOUT_MS = 40_000;
const RUN_TIMEOUT_MS = 20_000;
const PROCESS_STATE_TIMEOUT_MS = 15_000;
const PROCESS_EXIT_TIMEOUT_MS = 15_000;
const PROCESS_CLEANUP_TIMEOUT_MS = 5_000;
const PROCESS_TEST_OPTIONS = { timeout: PROCESS_TEST_TIMEOUT_MS };

const SUCCESS_MAX_WAIT_SECS = 5;
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

function fakeVirtualClock(startMs: number): string {
  const clock = join(directory, "virtual-clock");
  writeFileSync(clock, `${startMs}\n`);
  fakeExecutable(
    "date",
    `case "$*" in
  "+%s%3N") printf '%s' "$(sed -n '1p' "${clock}")" ;;
  "-u +%Y%m%dT%H%M%SZ") printf '20260908T000000Z' ;;
  "+%s") printf '1' ;;
  *) exit 1 ;;
esac`,
  );
  return clock;
}

function setVirtualClock(clock: string, atMs: number): string {
  return `printf '%s\\n' ${atMs} > "${clock}"`;
}

function advancingVirtualSleep(clock: string): void {
  fakeExecutable(
    "sleep",
    `perl -e 'my ($file, $seconds) = @ARGV; open(my $in, "<", $file) or die; my $now = <$in>; close $in; chomp $now; open(my $out, ">", $file) or die; printf $out "%d\\n", $now + $seconds * 1000; close $out' "${clock}" "$1"`,
  );
}

async function run(
  command: string[],
  options: {
    breakerFailures?: number;
    env?: NodeJS.ProcessEnv;
    failClosed?: boolean;
    home?: string;
    maxWaitSecs?: number;
    phase?: boolean;
    phaseName?: string;
    pollSecs?: string | null;
    token?: string;
  } = {},
  timeoutMs = RUN_TIMEOUT_MS,
): Promise<{
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(
    "bash",
    [
      RUNNER,
      ...(options.phase === true ? ["phase"] : []),
      "fluncle-enrich",
      ...(options.phaseName === undefined ? [] : ["--phase", options.phaseName]),
      "--",
      ...command,
    ],
    {
      detached: true,
      env: runnerEnvironment(options),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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
    const outcome = await new Promise<ProcessOutcome>((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("close", (code, signal) => resolvePromise({ code, signal }));
      timer = setTimeout(() => rejectPromise(new Error("process deadline exceeded")), timeoutMs);
    });
    return { signal: outcome.signal, status: outcome.code, stderr, stdout };
  } catch (error) {
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
  options: {
    breakerFailures?: number;
    env?: NodeJS.ProcessEnv;
    failClosed?: boolean;
    home?: string;
    maxWaitSecs?: number;
    pollSecs?: string | null;
    token?: string;
  } = {},
): NodeJS.ProcessEnv {
  const inheritedPath = process.env.PATH ?? "/usr/bin:/bin";
  const home = options.home ?? directory;
  const environment: NodeJS.ProcessEnv = {
    DATABASE_ADMISSION_BREAKER_FAILURES: String(options.breakerFailures ?? 1000),
    DATABASE_ADMISSION_FAIL_CLOSED: options.failClosed === true ? "true" : "false",
    DATABASE_ADMISSION_HTTP_TIMEOUT_SECS: "1",
    DATABASE_ADMISSION_KILL_GRACE_SECS: "1",
    DATABASE_ADMISSION_MAX_WAIT_SECS: String(options.maxWaitSecs ?? SUCCESS_MAX_WAIT_SECS),
    FLUNCLE_API_BASE_URL: "https://admission.invalid",
    FLUNCLE_API_TOKEN: options.token === undefined ? "test-token" : options.token,
    HEALTHCHECK_CRON_OUTPUT_DIR: join(directory, "cron-output"),
    HOME: home,
    PATH: `${binDirectory}:${inheritedPath}`,
  };
  if (options.pollSecs !== null) {
    environment.DATABASE_ADMISSION_POLL_SECS = options.pollSecs ?? "1";
  }
  return { ...environment, ...options.env };
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
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
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
      } catch {}
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
const PUBLIC_LATENCY_RESPONSE = `echo '{"contenderId":"fluncle-enrich:run","enforced":true,"fencingToken":null,"heavyRead":false,"heartbeatAfterMs":30000,"holdMs":0,"lane":"write","leaseExpiresAtMs":null,"operationId":"track.enrich","outcome":"queued","queueAgeMs":12,"recovered":false,"waitMs":12,"yieldReason":"public-latency"}'`;
const STALL_TOLERANT_GRANT = (leaseRemainingMs: number, heartbeatAfterMs: number) =>
  `echo '{"contenderId":"fluncle-enrich:run","enforced":true,"fencingToken":7,"heavyRead":false,"heartbeatAfterMs":${heartbeatAfterMs},"holdMs":0,"lane":"write","leaseExpiresAtMs":91000,"leaseRemainingMs":${leaseRemainingMs},"operationId":"track.enrich","outcome":"acquired","queueAgeMs":12,"recovered":false,"retryAfterMs":null,"waitMs":12,"yieldReason":null}'`;
const MALFORMED_YIELD_QUEUED_RESPONSE = `echo '{"contenderId":"fluncle-enrich:run","enforced":true,"fencingToken":null,"heavyRead":false,"heartbeatAfterMs":30000,"holdMs":0,"lane":"write","leaseExpiresAtMs":null,"operationId":"track.enrich","outcome":"queued","queueAgeMs":12,"recovered":false,"waitMs":12,"yieldReason":"queue\\\\malformed"}'`;

describe("database admission unit runner", () => {
  it(
    "cleanup does not wait for an exit from a child that never spawned",
    PROCESS_TEST_OPTIONS,
    async () => {
      const child = spawn(join(directory, "missing-shell"), [], { stdio: "ignore" });
      const error = await new Promise<Error>((resolvePromise) => {
        child.once("error", resolvePromise);
      });
      expect(error).toMatchObject({ code: "ENOENT" });
      expect(child.pid).toBeUndefined();
      await stopSpawnedProcess(child);
    },
  );

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

  it.each([
    ["an edge 5xx", `printf '%s\\n%s\\n' '{}' '503'`],
    ["a request past the ceiling", "sleep 1.1\nexit 28"],
  ])(
    "fails open at once in shadow mode when the coordinator answers %s",
    async (_label, response) => {
      fakeCurl(response);
      const result = await run(["bash", "-c", "printf shadow"]);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("shadow");
      expect(result.stderr).toContain('"outcome":"shadow-unavailable"');
      expect(result.stderr).not.toContain('"outcome":"acquire-retry"');
      expect(readFileSync(curlLog, "utf8").match(/"action":"acquire"/g)?.length ?? 0).toBe(1);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "fails closed after the whole window when the locally armed coordinator never answers",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeCurl(`
if printf '%s' "$*" | grep -q '"action":"acquire"'; then
  sleep 1.1
  exit 28
fi
printf '{}'
`);
      const payloadMarker = join(directory, "payload-started");
      const result = await run(["bash", "-c", `printf started > "${payloadMarker}"`], {
        failClosed: true,
        maxWaitSecs: 3,
      });

      expect(result.status).toBe(0);
      expect(existsSync(payloadMarker)).toBe(false);
      expect(result.stderr).toContain('"outcome":"acquire-retry"');
      expect(result.stderr).toContain('"outcome":"acquisition-gateway-transport"');
      expect(result.stderr).toContain('"yield_reason":"gateway-transport"');
      const calls = readFileSync(curlLog, "utf8");
      expect(calls.match(/"action":"acquire"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
      const summary = markerSummary();
      expect(summary).toMatchObject({
        admissionOutcome: "acquisition-gateway-transport",
        admissionYieldReason: "gateway-transport",
        checked: null,
        errors: 0,
        expectedIntervalMs: null,
        gateState: "admission-skipped",
        payloadStarted: false,
        produced: null,
        queueDepth: null,
      });
      expect(summary.admissionWaitMs).toBeGreaterThanOrEqual(3_000);

      expect(calls).toContain('"summary_raw"');
    },
  );

  it(
    "retries an acquire that outlives the request ceiling and runs the payload on the late grant",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeCurl(`
acquire_count="$(grep -c '"action":"acquire"' "${curlLog}")"
if printf '%s' "$*" | grep -q '"action":"acquire"' && [ "$acquire_count" -le 2 ]; then
  sleep 1.1
  exit 28
fi
${ACQUIRED_RESPONSE}
`);
      const payloadMarker = join(directory, "payload-started");
      const result = await run(["bash", "-c", `printf started > "${payloadMarker}"`], {
        failClosed: true,
        maxWaitSecs: 15,
      });

      expect(result.status).toBe(0);
      expect(existsSync(payloadMarker)).toBe(true);
      expect(result.stderr.match(/"outcome":"acquire-retry"/g)).toHaveLength(2);
      expect(result.stderr).toContain('"yield_reason":"gateway-transport"');
      expect(result.stderr).toContain('"outcome":"released"');
      expect(result.stderr).not.toContain('"outcome":"acquisition-gateway-transport"');
      const calls = readFileSync(curlLog, "utf8");
      expect(calls.match(/"action":"acquire"/g)?.length ?? 0).toBe(3);
      expect(calls).toContain('"action":"release"');
    },
  );

  it(
    "retries a gateway transport failure inside the acquisition window",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeCurl(`
if printf '%s' "$*" | grep -q '"action":"acquire"' && [ "$(grep -c '"action":"acquire"' "${curlLog}")" -eq 1 ]; then
  printf '%s\\n%s\\n' '{}' '503'
  exit 0
fi
${ACQUIRED_RESPONSE}
`);
      const payloadMarker = join(directory, "payload-started");
      const result = await run(["bash", "-c", `printf started > "${payloadMarker}"`], {
        failClosed: true,
        maxWaitSecs: 10,
      });

      expect(result.status).toBe(0);
      expect(existsSync(payloadMarker)).toBe(true);
      expect(result.stderr).toContain('"outcome":"acquire-retry"');
      expect(result.stderr).toContain('"yield_reason":"gateway-transport"');
      expect(result.stderr).toContain('"outcome":"released"');
      expect(result.stderr).not.toContain('"outcome":"acquisition-gateway-transport"');
      expect(readFileSync(curlLog, "utf8").match(/"action":"acquire"/g)?.length ?? 0).toBe(2);
    },
  );

  it(
    "yields at once on a validation rejection instead of retrying it",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeCurl(`printf '%s\\n%s\\n' '{"code":"invalid_request"}' '400'`);
      const payloadMarker = join(directory, "payload-started");
      const result = await run(["bash", "-c", `printf started > "${payloadMarker}"`], {
        failClosed: true,
      });

      expect(result.status).toBe(0);
      expect(existsSync(payloadMarker)).toBe(false);
      expect(result.stderr).not.toContain('"outcome":"acquire-retry"');
      expect(result.stderr).toContain('"outcome":"acquisition-unavailable"');
      expect(result.stderr).toContain('"yield_reason":"coordinator-unavailable"');
      expect(readFileSync(curlLog, "utf8").match(/"action":"acquire"/g)?.length ?? 0).toBe(1);
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

      const result = await run(["bash", "-c", `printf started > "${payloadMarker}"`], {
        maxWaitSecs: 10,
      });

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
      fakeVirtualClock(1_000);
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
        admissionWaitMs: 0,
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
    "preserves public latency when the final poll sleep exhausts acquisition",
    PROCESS_TEST_OPTIONS,
    async () => {
      advancingVirtualSleep(fakeVirtualClock(1_000));
      fakeCurl(PUBLIC_LATENCY_RESPONSE);
      const payloadMarker = join(directory, "payload-started");
      const result = await run(["bash", "-c", `printf started > "${payloadMarker}"`], {
        maxWaitSecs: 1,
      });

      expect(result.status).toBe(0);
      expect(existsSync(payloadMarker)).toBe(false);
      expect(
        readFileSync(curlLog, "utf8").match(/"action":"acquire"/g)?.length ?? 0,
      ).toBeGreaterThanOrEqual(1);
      expect(result.stderr).toContain('"outcome":"wait-expired"');
      expect(result.stderr).toContain('"yield_reason":"public-latency"');
      expect(markerSummary()).toMatchObject({
        admissionOutcome: "wait-expired",
        admissionWaitMs: 1_000,
        admissionYieldReason: "public-latency",
      });
    },
  );

  it(
    "preserves the last admitted reason when an in-flight retry exhausts acquisition",
    PROCESS_TEST_OPTIONS,
    async () => {
      const clock = fakeVirtualClock(1_000);
      fakeExecutable("sleep", ":");
      fakeCurl(`
acquire_count="$(grep -c '"action":"acquire"' "${curlLog}")"
if [ "$acquire_count" -eq 1 ]; then
  ${PUBLIC_LATENCY_RESPONSE}
elif [ "$acquire_count" -eq 2 ]; then
  ${setVirtualClock(clock, 2_000)}
  exit 28
else
  printf '{}'
fi
`);
      const result = await run(["bash", "-c", "exit 0"], { maxWaitSecs: 1 });

      expect(result.status).toBe(0);
      expect(readFileSync(curlLog, "utf8").match(/"action":"acquire"/g)?.length ?? 0).toBe(2);
      expect(result.stderr).toContain('"outcome":"wait-expired"');
      expect(result.stderr).toContain('"yield_reason":"public-latency"');
      expect(markerSummary()).toMatchObject({
        admissionOutcome: "wait-expired",
        admissionWaitMs: 1_000,
        admissionYieldReason: "public-latency",
      });
    },
  );

  it(
    "keeps a known HTTP failure typed when it arrives at the deadline boundary",
    PROCESS_TEST_OPTIONS,
    async () => {
      const clock = fakeVirtualClock(1_000);
      fakeExecutable("sleep", ":");
      fakeCurl(`
acquire_count="$(grep -c '"action":"acquire"' "${curlLog}")"
if [ "$acquire_count" -eq 1 ]; then
  ${PUBLIC_LATENCY_RESPONSE}
elif [ "$acquire_count" -eq 2 ]; then
  ${setVirtualClock(clock, 2_000)}
  printf '{}\\n401\\n'
else
  printf '{}'
fi
`);
      const result = await run(["bash", "-c", "exit 0"], { maxWaitSecs: 1 });

      expect(result.status).toBe(0);
      expect(readFileSync(curlLog, "utf8").match(/"action":"acquire"/g)?.length ?? 0).toBe(2);
      expect(result.stderr).toContain('"outcome":"acquisition-authentication-failed"');
      expect(result.stderr).toContain('"yield_reason":"authentication-failed"');
      expect(markerSummary()).toMatchObject({
        admissionOutcome: "acquisition-authentication-failed",
        admissionYieldReason: "authentication-failed",
      });
    },
  );

  it(
    "retries a pre-deadline gateway failure and keeps the last admitted reason at the deadline",
    PROCESS_TEST_OPTIONS,
    async () => {
      const clock = fakeVirtualClock(1_000);
      fakeExecutable(
        "sleep",
        `if [ "$(wc -l < "${curlLog}")" -ge 2 ]; then ${setVirtualClock(clock, 2_000)}; fi`,
      );
      fakeCurl(`
if [ "$(wc -l < "${curlLog}")" -eq 1 ]; then
  ${PUBLIC_LATENCY_RESPONSE}
else
  printf '{}\\n503\\n'
fi
`);
      const result = await run(["bash", "-c", "exit 0"], { maxWaitSecs: 1 });

      expect(result.status).toBe(0);
      expect(readFileSync(curlLog, "utf8").match(/"action":"acquire"/g)?.length ?? 0).toBe(2);
      expect(result.stderr).toContain('"outcome":"acquire-retry"');
      expect(result.stderr).toContain('"yield_reason":"gateway-transport"');
      expect(result.stderr).toContain('"outcome":"wait-expired"');
      expect(result.stderr).not.toContain('"outcome":"acquisition-gateway-transport"');
      expect(markerSummary()).toMatchObject({
        admissionOutcome: "wait-expired",
        admissionWaitMs: 1_000,
        admissionYieldReason: "public-latency",
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
    "polls within the two-second default when the polling interval is absent",
    PROCESS_TEST_OPTIONS,
    async () => {
      const sleepLog = join(directory, "sleep.log");
      const payloadMarker = join(directory, "payload-started");
      fakeExecutable("sleep", `printf '%s\\n' "$*" >> "${sleepLog}"`);
      fakeCurl(`
if [ "$(wc -l < "${curlLog}")" -eq 1 ]; then
  ${QUEUED_RESPONSE}
else
  ${ACQUIRED_RESPONSE}
fi
`);

      const result = await run(["bash", "-c", `printf started > "${payloadMarker}"`], {
        maxWaitSecs: 10,
        pollSecs: null,
      });

      expect(result.status).toBe(0);
      expect(existsSync(payloadMarker)).toBe(true);
      const firstPollSeconds = Number(readFileSync(sleepLog, "utf8").split("\n")[0]);
      expect(firstPollSeconds).toBeGreaterThanOrEqual(1);
      expect(firstPollSeconds).toBeLessThanOrEqual(2);
      expect(result.stderr).toContain('"outcome":"released"');
      expect(readFileSync(curlLog, "utf8")).toContain('"action":"release"');
    },
  );

  it.each([
    ["empty", ""],
    ["zero", "0"],
  ])(
    "rejects an explicit %s polling interval before making a request",
    async (_label, pollSecs) => {
      fakeCurl(ACQUIRED_RESPONSE);
      const result = await run(["bash", "-c", "exit 0"], { pollSecs });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        "DATABASE_ADMISSION_POLL_SECS must be a positive integer between 1 and 30",
      );
      expect(existsSync(curlLog)).toBe(false);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it.each([
    [
      "database busy",
      `printf '%s\\n%s\\n' '{"code":"database_busy"}' '503'`,
      "acquisition-database-busy",
      "database-busy",
    ],
    [
      "authentication",
      `printf '%s\\n%s\\n' '{}' '401'`,
      "acquisition-authentication-failed",
      "authentication-failed",
    ],
  ])(
    "reports %s acquisition failure without retrying it",
    async (_label, response, outcome, yieldReason) => {
      fakeCurl(response);
      const payloadMarker = join(directory, "payload-started");
      const result = await run(["bash", "-c", `printf started > "${payloadMarker}"`]);

      expect(result.status).toBe(0);
      expect(existsSync(payloadMarker)).toBe(false);
      expect(result.stderr).toContain(`"outcome":"${outcome}"`);
      expect(result.stderr).toContain(`"yield_reason":"${yieldReason}"`);
      const calls = readFileSync(curlLog, "utf8");
      expect(calls.match(/"action":"acquire"/g)?.length ?? 0).toBe(1);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "returns a phase yield without running the command or writing whole-run evidence",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeCurl(QUEUED_RESPONSE);
      const payloadMarker = join(directory, "payload-started");
      const result = await run(["bash", "-c", `printf started > "${payloadMarker}"`], {
        maxWaitSecs: 0,
        phase: true,
        phaseName: "beatport",
      });

      expect(result.status).toBe(75);
      expect(existsSync(payloadMarker)).toBe(false);
      expect(existsSync(join(directory, "cron-output"))).toBe(false);
      expect(readFileSync(curlLog, "utf8")).not.toContain('"summary_raw"');
      expect(result.stderr).toContain('"outcome":"wait-expired"');
      expect(result.stderr).toContain('"phase_scoped":true');
      expect(result.stderr).toContain('"phase":"beatport"');
    },
  );

  it(
    "returns a typed phase failure without running the command or writing whole-run evidence",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeCurl(`printf '%s\\n%s\\n' '{"code":"database_busy"}' '503'`);
      const payloadMarker = join(directory, "payload-started");
      const result = await run(["bash", "-c", `printf started > "${payloadMarker}"`], {
        phase: true,
      });

      expect(result.status).toBe(75);
      expect(existsSync(payloadMarker)).toBe(false);
      expect(existsSync(join(directory, "cron-output"))).toBe(false);
      expect(readFileSync(curlLog, "utf8")).not.toContain('"summary_raw"');
      expect(result.stderr).toContain('"outcome":"acquisition-database-busy"');
      expect(result.stderr).toContain('"yield_reason":"database-busy"');
      expect(result.stderr).toContain('"phase_scoped":true');
    },
  );

  it(
    "holds admission only across commands declared as critical phases",
    PROCESS_TEST_OPTIONS,
    () => {
      const timeline = join(directory, "phase-timeline");
      fakeCurl(`
case "$*" in
  *'"action":"acquire"'*) printf 'acquire\\n' >> "${timeline}" ;;
  *'"action":"release"'*) printf 'release\\n' >> "${timeline}" ;;
esac
${ACQUIRED_RESPONSE}
`);
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -e
"$1" phase fluncle-enrich -- bash -c 'printf "critical-one\\n" >> "$1"' critical "$2"
printf 'non-critical\\n' >> "$2"
"$1" phase fluncle-enrich -- bash -c 'printf "critical-two\\n" >> "$1"' critical "$2"`,
          "payload",
          RUNNER,
          timeline,
        ],
        {
          encoding: "utf8",
          env: runnerEnvironment(),
          timeout: RUN_TIMEOUT_MS,
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(timeline, "utf8").trim().split("\n")).toEqual([
        "acquire",
        "critical-one",
        "release",
        "non-critical",
        "acquire",
        "critical-two",
        "release",
      ]);
      expect(result.stderr.match(/"phase_scoped":true/g)).toHaveLength(2);
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

  it(
    "retries a release the slow coordinator timed out, so a granted lease is never left orphaned",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeExecutable("sleep", ":");
      const releaseAttempts = join(directory, "release-attempts");

      fakeCurl(`case "$*" in
  *'"action":"release"'*)
    printf x >> "${releaseAttempts}"
    [ "$(wc -c < "${releaseAttempts}")" -ge 2 ] || exit 28
    echo '{"ok":true}'
    ;;
  *) ${ACQUIRED_RESPONSE} ;;
esac`);
      const result = await run(["bash", "-c", "printf complete"]);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("complete");
      const calls = readFileSync(curlLog, "utf8");
      const releaseCalls = calls.split("\n").filter((call) => call.includes('"action":"release"'));
      expect(releaseCalls).toHaveLength(2);
      expect(releaseCalls.every((call) => call.includes('"fencingToken":7'))).toBe(true);
      expect(result.stderr).toContain('"outcome":"released"');
    },
  );

  it(
    "stops retrying a terminal release against a dead coordinator after a bounded number of attempts",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeExecutable("sleep", ":");
      fakeCurl(`case "$*" in
  *'"action":"release"'*) exit 28 ;;
  *) ${ACQUIRED_RESPONSE} ;;
esac`);
      const result = await run(["bash", "-c", "printf complete"]);

      expect(result.status).toBe(0);
      expect(readFileSync(curlLog, "utf8").match(/"action":"release"/g)).toHaveLength(3);
    },
  );

  it(
    "never retries a release the coordinator definitively rejected",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeExecutable("sleep", ":");
      fakeCurl(`case "$*" in
  *'"action":"release"'*) printf '{"code":"invalid_request"}\\n409' ;;
  *) ${ACQUIRED_RESPONSE} ;;
esac`);
      const result = await run(["bash", "-c", "printf complete"]);

      expect(result.status).toBe(0);
      expect(readFileSync(curlLog, "utf8").match(/"action":"release"/g)).toHaveLength(1);
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
    "kills the payload process group and fails fenced when a heartbeat is definitively rejected",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeCurl(`
if printf '%s' "$*" | grep -q '"action":"heartbeat"'; then
  printf '%s\\n%s\\n' '{}' '401'
  exit 0
fi
${ACQUIRED_RESPONSE}
`);
      const result = await run(["bash", "-c", "while :; do sleep 1; done"]);
      expect(result.status).toBe(75);
      expect(result.signal).toBeNull();
      expect(result.stderr).not.toContain('"outcome":"heartbeat-retry"');
      expect(result.stderr).toContain('"outcome":"fenced"');
      expect(result.stderr).toContain('"yield_reason":"partition"');
    },
  );

  it(
    "keeps the payload running across one transient heartbeat failure",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeCurl(`
if printf '%s' "$*" | grep -q '"action":"heartbeat"'; then
  heartbeat_count="$(grep -c '"action":"heartbeat"' "${curlLog}")"
  if [ "$heartbeat_count" -eq 1 ]; then
    exit 28
  fi
  if [ "$heartbeat_count" -eq 2 ]; then
    printf '%s\\n%s\\n' '{}' '500'
    exit 0
  fi
fi
${ACQUIRED_RESPONSE}
`);
      const result = await run(["bash", "-c", "sleep 6; printf complete"]);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("complete");
      expect(result.stderr.match(/"outcome":"heartbeat-retry"/g)).toHaveLength(2);
      expect(result.stderr).toContain('"yield_reason":"gateway-transport"');
      expect(result.stderr).toContain('"yield_reason":"coordinator-unavailable"');
      expect(result.stderr).toMatch(/"outcome":"released"[^\n]*"yield_reason":""/);
      expect(result.stderr).not.toContain('"outcome":"fenced"');
      const calls = readFileSync(curlLog, "utf8");
      expect(calls.match(/"action":"heartbeat"/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
      expect(calls.match(/"action":"release"/g)?.length ?? 0).toBe(1);
    },
  );

  it(
    "stops the payload when heartbeats keep failing past the local lease deadline",
    PROCESS_TEST_OPTIONS,
    async () => {
      const advanceClock = join(directory, "advance-heartbeat-clock");
      const startedAtMs = Date.now();
      fakeExecutable(
        "date",
        `if [ "$1" = "+%s%3N" ]; then
  if [ -e "${advanceClock}" ]; then printf '100000000'; else perl -MTime::HiRes=time -e 'printf "%.0f", time() * 1000 - ${startedAtMs} + 1000'; fi
  exit 0
fi
exec /bin/date "$@"`,
      );
      fakeCurl(`
if printf '%s' "$*" | grep -q '"action":"heartbeat"'; then
  if [ "$(grep -c '"action":"heartbeat"' "${curlLog}")" -ge 2 ]; then
    printf advance > "${advanceClock}"
  fi
  exit 28
fi
${ACQUIRED_RESPONSE}
`);
      const result = await run(["bash", "-c", "while :; do sleep 1; done"]);

      expect(result.status).toBe(75);
      expect(result.signal).toBeNull();
      expect(result.stderr).toContain('"outcome":"heartbeat-retry"');
      expect(result.stderr).toContain('"outcome":"fenced"');
      expect(result.stderr).toContain('"yield_reason":"heartbeat-deadline"');
      expect(readFileSync(curlLog, "utf8")).toContain('"action":"release"');
    },
  );

  it(
    "kills the payload group before lease expiry when a live heartbeat owner is paused",
    PROCESS_TEST_OPTIONS,
    async () => {
      const advanceClock = join(directory, "advance-watchdog-clock");
      const payloadMarker = join(directory, "paused-owner-payload");
      fakeExecutable(
        "date",
        `if [ "$1" = "+%s%3N" ]; then
  if [ -e "${advanceClock}" ]; then printf '100000000'; else printf '1000'; fi
  exit 0
fi
exec /usr/bin/date "$@"`,
      );
      fakeCurl(
        `echo '{"contenderId":"fluncle-enrich:run","enforced":true,"fencingToken":7,"heavyRead":false,"heartbeatAfterMs":30000,"holdMs":0,"lane":"write","leaseExpiresAtMs":91000,"operationId":"track.enrich","outcome":"acquired","queueAgeMs":12,"recovered":false,"waitMs":12,"yieldReason":null}'`,
      );
      const runner = spawn(
        "bash",
        [
          RUNNER,
          "fluncle-enrich",
          "--",
          "bash",
          "-c",
          `printf '%s' "$$" > "${payloadMarker}.tmp"; mv "${payloadMarker}.tmp" "${payloadMarker}"; while :; do sleep 1; done`,
        ],
        { env: runnerEnvironment(), stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      runner.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-8_192);
      });

      try {
        await waitUntil(() => existsSync(payloadMarker), undefined, "paused-owner payload start");
        const payloadPid = Number(readFileSync(payloadMarker, "utf8"));
        expect(Number.isInteger(payloadPid) && payloadPid > 0).toBe(true);
        runner.kill("SIGSTOP");
        writeFileSync(advanceClock, "advance\n");
        await waitUntil(
          () => !processIsExecuting(payloadPid),
          PROCESS_STATE_TIMEOUT_MS,
          "heartbeat deadline containment",
        );
        runner.kill("SIGCONT");
        const outcome = await waitForExit(runner);

        expect(outcome).toEqual({ code: 75, signal: null });
        expect(stderr).toContain('"outcome":"fenced"');
        expect(stderr).toContain('"yield_reason":"heartbeat-deadline"');
      } finally {
        runner.kill("SIGCONT");
        await stopSpawnedProcess(runner);
      }
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
          'trap "" TERM; printf "%s:%s" "$PPID" "$$" > "${1}.tmp"; mv "${1}.tmp" "$1"; while :; do sleep 1; done',
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
printf '%s' "$$" > "${setprivStarted}.tmp"
mv "${setprivStarted}.tmp" "${setprivStarted}"
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

function breakerState(): { cooldownMs: number; sinceMs: number; untilMs: number } | null {
  const file = join(directory, ".database-admission", "breaker");
  if (!existsSync(file)) {
    return null;
  }
  const [sinceMs, untilMs, cooldownMs] = readFileSync(file, "utf8").trim().split(" ").map(Number);
  return { cooldownMs: cooldownMs ?? 0, sinceMs: sinceMs ?? 0, untilMs: untilMs ?? 0 };
}

function pendingDebts(): string[] {
  const pending = join(directory, ".database-admission", "pending");
  return existsSync(pending) ? readdirSync(pending).filter((entry) => !entry.startsWith(".")) : [];
}

function runIdOf(stderr: string): string {
  const runId = /"run_id":"([^"]+)"/.exec(stderr)?.[1];
  expect(runId).toBeTruthy();
  return runId ?? "";
}

function acquireCount(): number {
  return existsSync(curlLog)
    ? (readFileSync(curlLog, "utf8").match(/"action":"acquire"/g)?.length ?? 0)
    : 0;
}

describe("database admission stall behaviour", () => {
  it(
    "backs acquire retries off exponentially with full jitter under a capped ceiling",
    PROCESS_TEST_OPTIONS,
    async () => {
      const clock = fakeVirtualClock(1_000_000);
      const sleepLog = join(directory, "sleep.log");
      fakeExecutable(
        "sleep",
        `printf '%s\\n' "$1" >> "${sleepLog}"
perl -e 'my ($file, $seconds) = @ARGV; open(my $in, "<", $file) or die; my $now = <$in>; close $in; chomp $now; open(my $out, ">", $file) or die; printf $out "%d\\n", $now + $seconds * 1000; close $out' "${clock}" "$1"`,
      );
      fakeCurl("exit 28");
      const result = await run(["bash", "-c", "exit 0"], {
        failClosed: true,
        maxWaitSecs: 120,
        pollSecs: "2",
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain('"outcome":"acquisition-gateway-transport"');
      const sleeps = readFileSync(sleepLog, "utf8").trim().split("\n").map(Number);
      sleeps.forEach((seconds, index) => {
        expect(seconds).toBeGreaterThanOrEqual(0);
        expect(seconds).toBeLessThanOrEqual(Math.min(30, 2 * 2 ** index));
      });
      expect(acquireCount()).toBeGreaterThanOrEqual(5);
      expect(acquireCount()).toBeLessThan(40);
    },
  );

  it("retries a 524 origin timeout as a gateway failure", PROCESS_TEST_OPTIONS, async () => {
    fakeCurl(`
if printf '%s' "$*" | grep -q '"action":"acquire"' && [ "$(grep -c '"action":"acquire"' "${curlLog}")" -eq 1 ]; then
  printf '%s\\n%s\\n' '{}' '524'
  exit 0
fi
${ACQUIRED_RESPONSE}
`);
    const result = await run(["bash", "-c", "printf done"], { failClosed: true, maxWaitSecs: 10 });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("done");
    expect(result.stderr).toMatch(
      /"outcome":"acquire-retry"[^\n]*"yield_reason":"gateway-transport"/,
    );
    expect(acquireCount()).toBe(2);
  });

  it(
    "sends the stall-tolerant protocol version and its acquisition deadline",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeCurl(ACQUIRED_RESPONSE);
      await run(["bash", "-c", "exit 0"]);

      const acquire = readFileSync(curlLog, "utf8")
        .split("\n")
        .find((call) => call.includes('"action":"acquire"'));
      expect(acquire).toContain('"protocolVersion":2');
      expect(acquire).toMatch(/"notAfterMs":\d+/);
    },
  );

  it(
    "keeps a healthy payload running through a heartbeat outage its lease still covers",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeCurl(`
if printf '%s' "$*" | grep -q '"action":"heartbeat"'; then
  if [ "$(grep -c '"action":"heartbeat"' "${curlLog}")" -le 4 ]; then
    exit 28
  fi
  ${STALL_TOLERANT_GRANT(420_000, 1_000)}
  exit 0
fi
${STALL_TOLERANT_GRANT(420_000, 1_000)}
`);
      const result = await run(["bash", "-c", "sleep 8; printf complete"]);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("complete");
      expect(
        result.stderr.match(/"outcome":"heartbeat-retry"/g)?.length ?? 0,
      ).toBeGreaterThanOrEqual(2);
      expect(result.stderr).toContain('"outcome":"released"');
      expect(result.stderr).not.toContain('"outcome":"fenced"');
    },
  );

  it(
    "fences the payload before a short granted lease can expire on the server",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeCurl(`
if printf '%s' "$*" | grep -q '"action":"heartbeat"'; then
  exit 28
fi
${STALL_TOLERANT_GRANT(7_500, 1_000)}
`);
      const startedAt = Date.now();
      const result = await run(["bash", "-c", "sleep 30"]);

      expect(result.status).toBe(75);
      expect(result.stderr).toContain('"outcome":"fenced"');
      expect(result.stderr).toContain('"yield_reason":"heartbeat-deadline"');
      expect(Date.now() - startedAt).toBeLessThan(7_500);
    },
  );

  it(
    "opens the box-wide breaker after repeated gateway failures and records a non-alerting skip",
    PROCESS_TEST_OPTIONS,
    async () => {
      advancingVirtualSleep(fakeVirtualClock(1_000_000));
      fakeCurl("exit 28");
      const payloadMarker = join(directory, "payload-started");
      const first = await run(["bash", "-c", `printf started > "${payloadMarker}"`], {
        breakerFailures: 2,
        failClosed: true,
        maxWaitSecs: 120,
      });

      expect(first.status).toBe(0);
      expect(existsSync(payloadMarker)).toBe(false);
      expect(acquireCount()).toBe(2);
      expect(first.stderr).toContain('"event":"database.admission.breaker"');
      expect(first.stderr).toMatch(/"outcome":"breaker-open"[^\n]*"yield_reason":"breaker-open"/);
      expect(markerSummary()).toEqual({
        admissionOutcome: "breaker-open",
        admissionWaitMs: expect.any(Number),
        admissionYieldReason: "breaker-open",
        checked: null,
        errors: 0,
        expectedIntervalMs: null,
        gateState: "admission-skipped",
        payloadStarted: false,
        produced: null,
        queueDepth: null,
      });
      expect(breakerState()).toMatchObject({ cooldownMs: 60_000 });
      expect(pendingDebts()).toEqual([`${runIdOf(first.stderr)}.cancel`]);

      const second = await run(["bash", "-c", `printf started > "${payloadMarker}"`], {
        breakerFailures: 2,
        failClosed: true,
      });
      expect(second.status).toBe(0);
      expect(acquireCount()).toBe(2);
      expect(second.stderr).toMatch(/"outcome":"breaker-open"/);
      expect(existsSync(payloadMarker)).toBe(false);

      const phase = await run(["bash", "-c", `printf started > "${payloadMarker}"`], {
        breakerFailures: 2,
        failClosed: true,
        phase: true,
      });
      expect(phase.status).toBe(75);
      expect(phase.stderr).toMatch(/"outcome":"breaker-open"[^\n]*"phase_scoped":true/);
      expect(acquireCount()).toBe(2);
    },
  );

  it(
    "keeps shadow firings on their fail-open path while the breaker is open",
    PROCESS_TEST_OPTIONS,
    async () => {
      advancingVirtualSleep(fakeVirtualClock(1_000_000));
      fakeCurl("exit 28");
      await run(["bash", "-c", "exit 0"], { breakerFailures: 1, failClosed: true });
      expect(breakerState()).not.toBeNull();

      const shadow = await run(["bash", "-c", "printf fallback"], { breakerFailures: 1 });
      expect(shadow.stdout).toBe("fallback");
      expect(shadow.stderr).toMatch(
        /"outcome":"shadow-unavailable"[^\n]*"yield_reason":"breaker-open"/,
      );
      expect(acquireCount()).toBe(1);
    },
  );

  it(
    "lets exactly one half-open probe close the breaker and settle the stood-aside run's debt",
    PROCESS_TEST_OPTIONS,
    async () => {
      const clock = fakeVirtualClock(1_000_000);
      advancingVirtualSleep(clock);
      fakeCurl("exit 28");
      const stoodAside = await run(["bash", "-c", "exit 0"], {
        breakerFailures: 2,
        failClosed: true,
        maxWaitSecs: 120,
      });
      const stoodAsideRunId = runIdOf(stoodAside.stderr);
      const opened = breakerState();
      expect(opened).not.toBeNull();

      writeFileSync(clock, `${(opened?.untilMs ?? 0) + 1}\n`);
      writeFileSync(
        join(directory, ".database-admission", "breaker-probe"),
        `${(opened?.untilMs ?? 0) + 1} in-flight-prober\n`,
      );
      const blocked = await run(["bash", "-c", "exit 0"], { breakerFailures: 2, failClosed: true });
      expect(blocked.stderr).toMatch(/"outcome":"breaker-open"/);
      expect(acquireCount()).toBe(2);
      rmSync(join(directory, ".database-admission", "breaker-probe"));

      fakeCurl(ACQUIRED_RESPONSE);
      const payloadMarker = join(directory, "payload-started");
      const probe = await run(["bash", "-c", `printf started > "${payloadMarker}"`], {
        breakerFailures: 2,
        failClosed: true,
      });

      expect(probe.status).toBe(0);
      expect(existsSync(payloadMarker)).toBe(true);
      expect(probe.stderr).toContain('"state":"half-open"');
      expect(probe.stderr).toContain('"state":"closed"');
      expect(breakerState()).toBeNull();
      expect(readFileSync(curlLog, "utf8")).toMatch(
        new RegExp(`"action":"cancel"[^\\n]*"runId":"${stoodAsideRunId}"`),
      );
      expect(pendingDebts()).toEqual([]);
    },
  );

  it(
    "reopens the breaker with a doubled cooldown when its half-open probe fails",
    PROCESS_TEST_OPTIONS,
    async () => {
      const clock = fakeVirtualClock(1_000_000);
      advancingVirtualSleep(clock);
      fakeCurl("exit 28");
      await run(["bash", "-c", "exit 0"], {
        breakerFailures: 2,
        failClosed: true,
        maxWaitSecs: 120,
      });
      const opened = breakerState();
      expect(opened).toMatchObject({ cooldownMs: 60_000 });

      writeFileSync(clock, `${(opened?.untilMs ?? 0) + 1}\n`);
      const probe = await run(["bash", "-c", "exit 0"], { breakerFailures: 2, failClosed: true });

      expect(probe.status).toBe(0);
      expect(probe.stderr).toContain('"state":"half-open"');
      expect(probe.stderr).toMatch(/"outcome":"breaker-open"/);
      expect(acquireCount()).toBe(3);
      expect(breakerState()).toMatchObject({ cooldownMs: 120_000, sinceMs: opened?.sinceMs });
      expect(existsSync(join(directory, ".database-admission", "breaker-probe"))).toBe(false);
    },
  );

  function halfOpenBreaker(clock: string, nowMs: number): string {
    const stateDirectory = join(directory, ".database-admission");
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(join(stateDirectory, "breaker"), `${nowMs - 120_000} ${nowMs - 1} 60000\n`);
    writeFileSync(clock, `${nowMs}\n`);
    return join(stateDirectory, "breaker-probe");
  }

  it(
    "reclaims an empty probe claim a crashed prober left behind so the breaker still half-opens",
    PROCESS_TEST_OPTIONS,
    async () => {
      const clock = fakeVirtualClock(1_000_000);
      advancingVirtualSleep(clock);
      const probeClaim = halfOpenBreaker(clock, 1_000_000);
      writeFileSync(probeClaim, "");
      fakeCurl(ACQUIRED_RESPONSE);
      const payloadMarker = join(directory, "payload-started");

      const result = await run(["bash", "-c", `printf started > "${payloadMarker}"`], {
        breakerFailures: 2,
        failClosed: true,
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain('"state":"half-open"');
      expect(result.stderr).toContain('"state":"closed"');
      expect(existsSync(payloadMarker)).toBe(true);
      expect(breakerState()).toBeNull();
      expect(existsSync(probeClaim)).toBe(false);
    },
  );

  it(
    "backs off when a stale probe claim was reclaimed by another firing between its read and its reclaim",
    PROCESS_TEST_OPTIONS,
    async () => {
      const clock = fakeVirtualClock(1_000_000);
      advancingVirtualSleep(clock);
      const probeClaim = halfOpenBreaker(clock, 1_000_000);
      writeFileSync(probeClaim, "1 crashed-prober\n");
      const freshClaim = "1000000 racing-prober";
      const racedMarker = join(directory, "raced");
      fakeExecutable(
        "mv",
        `arguments=("$@")
source_path="\${arguments[$((\${#arguments[@]} - 2))]}"
if [ "$source_path" = "${probeClaim}" ] && [ ! -e "${racedMarker}" ]; then
  : > "${racedMarker}"
  printf '%s\\n' "${freshClaim}" > "${probeClaim}"
fi
exec /bin/mv "$@"`,
      );
      fakeExecutable(
        "rm",
        `for argument in "$@"; do
  if [ "$argument" = "${probeClaim}" ] && [ ! -e "${racedMarker}" ]; then
    : > "${racedMarker}"
    printf '%s\\n' "${freshClaim}" > "${probeClaim}"
  fi
done
exec /bin/rm "$@"`,
      );
      fakeCurl(ACQUIRED_RESPONSE);

      const result = await run(["bash", "-c", "exit 0"], {
        breakerFailures: 2,
        failClosed: true,
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toMatch(/"outcome":"breaker-open"/);
      expect(result.stderr).not.toContain('"state":"half-open"');
      expect(acquireCount()).toBe(0);
      expect(readFileSync(probeClaim, "utf8").trim()).toBe(freshClaim);
    },
  );

  it(
    "never removes a probe claim it does not own when its own probe finishes",
    PROCESS_TEST_OPTIONS,
    async () => {
      const clock = fakeVirtualClock(1_000_000);
      advancingVirtualSleep(clock);
      const probeClaim = halfOpenBreaker(clock, 1_000_000);
      const foreignClaim = "1000000 another-prober";
      fakeCurl(`
if printf '%s' "$*" | grep -q '"action":"acquire"'; then
  printf '%s\\n' "${foreignClaim}" > "${probeClaim}"
fi
${ACQUIRED_RESPONSE}
`);

      const result = await run(["bash", "-c", "exit 0"], {
        breakerFailures: 2,
        failClosed: true,
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain('"state":"closed"');
      expect(readFileSync(probeClaim, "utf8").trim()).toBe(foreignClaim);
    },
  );

  it(
    "leaves an unanswered release as debt that the next reachable run settles",
    PROCESS_TEST_OPTIONS,
    async () => {
      fakeExecutable("sleep", ":");
      fakeCurl(`case "$*" in
  *'"action":"release"'*) exit 28 ;;
  *) ${ACQUIRED_RESPONSE} ;;
esac`);
      const stranded = await run(["bash", "-c", "printf complete"]);
      const strandedRunId = runIdOf(stranded.stderr);
      expect(stranded.status).toBe(0);
      expect(pendingDebts()).toEqual([`${strandedRunId}.release`]);

      fakeCurl(ACQUIRED_RESPONSE);
      const next = await run(["bash", "-c", "printf again"]);
      expect(next.status).toBe(0);
      expect(readFileSync(curlLog, "utf8")).toMatch(
        new RegExp(`"action":"release"[^\\n]*"runId":"${strandedRunId}"[^\\n]*"fencingToken":7`),
      );
      expect(pendingDebts()).toEqual([]);
    },
  );

  it(
    "rides out a five-minute coordinator stall without a retry storm, a killed payload, or a ghost lease",
    { timeout: 150_000 },
    async () => {
      const scale = 20;
      const epochMs = Date.now();
      const virtualStartMs = 1_000_000;
      const stallFromMs = virtualStartMs + 60_000;
      const stallUntilMs = virtualStartMs + 360_000;
      const holder = join(directory, "lane-holder");
      writeFileSync(holder, "");
      fakeExecutable(
        "date",
        `case "$*" in
  "+%s%3N") perl -MTime::HiRes=time -e 'printf "%.0f", ${virtualStartMs} + (time() * 1000 - ${epochMs}) * ${scale}' ;;
  "-u +%Y%m%dT%H%M%SZ") printf '20260908T000000Z' ;;
  "+%s") printf '1' ;;
  *) exit 1 ;;
esac`,
      );
      fakeExecutable(
        "sleep",
        `perl -MTime::HiRes=sleep -e 'my $real = $ARGV[0] / ${scale}; sleep($real < 0.02 ? 0.02 : $real)' "$1"`,
      );
      fakeExecutable(
        "curl",
        `now="$(date +%s%3N)"
request_timeout=10
body=""
previous=""
for argument in "$@"; do
  case "$previous" in
    --max-time) request_timeout="$argument" ;;
    --data-binary) body="$argument" ;;
  esac
  previous="$argument"
done
printf '%s %s\\n' "$now" "$body" >> "${curlLog}"
if [ "$now" -ge ${stallFromMs} ] && [ "$now" -lt ${stallUntilMs} ]; then
  perl -MTime::HiRes=sleep -e 'sleep($ARGV[0] / ${scale})' "$request_timeout"
  exit 28
fi
run_id="$(printf '%s' "$body" | sed -n 's/.*"runId":"\\([^"]*\\)".*/\\1/p')"
case "$body" in
  *'"action":"acquire"'*)
    if [ ! -s "${holder}" ] || [ "$(cat "${holder}")" = "$run_id" ]; then
      printf '%s' "$run_id" > "${holder}"
      ${STALL_TOLERANT_GRANT(90_000, 15_000)}
    else
      ${QUEUED_RESPONSE}
    fi
    ;;
  *'"action":"heartbeat"'*) ${STALL_TOLERANT_GRANT(420_000, 30_000)} ;;
  *'"action":"release"'*)
    if [ "$(cat "${holder}")" = "$run_id" ]; then : > "${holder}"; fi
    echo '{}'
    ;;
  *) echo '{}' ;;
esac`,
      );
      const stallOptions = {
        breakerFailures: 4,
        env: {
          DATABASE_ADMISSION_BREAKER_COOLDOWN_SECS: "30",
          DATABASE_ADMISSION_BREAKER_MAX_COOLDOWN_SECS: "120",
          DATABASE_ADMISSION_HTTP_TIMEOUT_SECS: "10",
        },
        failClosed: true,
        maxWaitSecs: 120,
      };
      const atVirtual = (virtualMs: number) =>
        new Promise((resolvePromise) =>
          setTimeout(resolvePromise, Math.max(0, epochMs + virtualMs / scale - Date.now())),
        );
      const holderMarker = join(directory, "holder-finished");
      const latecomerMarker = join(directory, "latecomer-finished");

      const running = run(
        ["bash", "-c", `sleep 400; printf done > "${holderMarker}"`],
        stallOptions,
        60_000,
      );
      const newcomers: ReturnType<typeof run>[] = [];
      for (const arrival of [80_000, 140_000, 200_000, 260_000]) {
        await atVirtual(arrival);
        newcomers.push(run(["bash", "-c", "exit 0"], stallOptions, 60_000));
      }
      const holderResult = await running;
      const newcomerResults = await Promise.all(newcomers);
      await atVirtual(560_000);
      const latecomer = await run(
        ["bash", "-c", `printf done > "${latecomerMarker}"`],
        stallOptions,
        60_000,
      );

      expect(holderResult.status, holderResult.stderr).toBe(0);
      expect(existsSync(holderMarker), holderResult.stderr).toBe(true);
      expect(holderResult.stderr).toContain('"outcome":"heartbeat-retry"');
      expect(holderResult.stderr).toContain('"outcome":"released"');
      expect(holderResult.stderr).not.toContain('"outcome":"fenced"');

      for (const newcomer of newcomerResults) {
        expect(newcomer.status).toBe(0);
        expect(newcomer.stderr).toMatch(/"outcome":"breaker-open"/);
      }

      const calls = readFileSync(curlLog, "utf8").trim().split("\n");
      const stalledAcquires = calls.filter((call) => {
        const at = Number(call.split(" ", 1)[0]);
        return at >= stallFromMs && at < stallUntilMs && call.includes('"action":"acquire"');
      });
      expect(stalledAcquires.length).toBeLessThanOrEqual(10);

      expect(latecomer.status, latecomer.stderr).toBe(0);
      expect(existsSync(latecomerMarker)).toBe(true);
      expect(latecomer.stderr).toContain('"outcome":"released"');
      expect(breakerState()).toBeNull();
      expect(readFileSync(holder, "utf8")).toBe("");
      expect(pendingDebts()).toEqual([]);
    },
  );
});
