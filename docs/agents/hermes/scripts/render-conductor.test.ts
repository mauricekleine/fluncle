// THE CONDUCTOR'S TRANSPORT CONTRACT — driven through the REAL script against a stubbed CLI.
//
// WHY THIS TEST EXISTS. The render conductor talks to its render box through one vendor CLI,
// and three of its rails live entirely inside that conversation:
//
//   1. THE RESTORING WINDOW. A resume can report success while the box spends the next
//      seconds restoring, and every call in that window fails with a typed restoring code —
//      the freshen ssh, both scp refreshes, and the render trigger. `await_box_ready` waits
//      that window out before the launch-line check can judge the box. The code is emitted by
//      the API, not the CLI, so it is matched in all three spellings the platform has used
//      (`box_restoring`, `boat_restoring`, `sandbox_restoring`).
//   2. THE BOUNDED RESUME. The CLI's resume blocks on readiness for up to half an hour, well
//      past the host unit's kill. It is bounded, and a resume that does not finish holds the
//      sandbox id instead of reprovisioning on top of a live box.
//   3. THE PIN. Every CLI call carries `--no-update`, or the checksum-pinned binary replaces
//      itself and the verb contract moves.
//
// A gate like that is unproven until a synthetic failure makes it fire, so every case runs
// `render-conductor.sh` itself against a stubbed `boat`/`fluncle` in a temp HOME — no network,
// no sandbox — and asserts on what the tick DID.
//
//   bun test docs/agents/hermes/scripts/render-conductor.test.ts

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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
import { join } from "node:path";

const CONDUCTOR = join(import.meta.dir, "render-conductor.sh");
const BOX_ID = "bx_under_test";
const QUEUE_HEAD = "001.1.1A";
// The fixture exercises a real shell lifecycle; these process budgets cover harness overhead,
// not an assertion about the conductor's production performance SLA. Since they assert nothing,
// they are sized for the worst machine this runs on rather than the best: every wait inside a
// tick is a stubbed `sleep`, so the wall clock here is spawn cost, and spawn cost is exactly what
// the rest of the lane running beside this file inflates. A budget that only fits an idle machine
// turns that contention into a red that says nothing about the conductor.
const SUBPROCESS_TIMEOUT_MS = 40_000;
const PROCESS_FIXTURE_TIMEOUT_MS = 60_000;

/** `-1` means "restoring forever"; any other count is how many calls fail before the box answers. */
type Tick = {
  args?: readonly string[];
  doneResult?: string;
  initialState?: "idle" | "rendering";
  legacyEnvNames?: boolean;
  listHasBox?: boolean;
  nowSequence?: readonly number[];
  queueExitCode?: number;
  queueResponse?: string;
  queueStderr?: string;
  readyTimeout?: number;
  restoringCode?: string;
  restoringCalls: number;
  resumeExitCode?: number;
  timeoutExitCode?: number;
  trackHasVideo?: boolean;
};

type TickResult = {
  boxIdFile: string;
  calls: string[];
  exitCode: number;
  log: string;
  noUpdateViolations: string[];
  orphans: string;
  sleepCalls: string[];
  state: string;
  stdout: string;
};

// The stub CLI. It answers the read-only verbs the tick needs (`login`, `list`, `resume`,
// `stop`, `extend`) and fails `ssh`/`scp` with the platform's real restoring body until the
// countdown runs out — the same shape the conductor greps for. It also records every call and
// flags any that arrived WITHOUT the global `--no-update`, which is what keeps the pinned
// binary pinned.
const BOAT_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$STUB_DIR/calls"
if [ "\${1:-}" = "--no-update" ]; then
  shift
else
  printf '%s\\n' "$*" >>"$STUB_DIR/no-update-violations"
fi
verb="\${1:-}"; shift || true
case "$verb" in
  --version) printf 'boat 1.0.9\\n'; exit 0 ;;
  login) cat >/dev/null 2>&1 || true; exit "\${STUB_LOGIN_EXIT:-0}" ;;
  resume) exit "\${STUB_RESUME_EXIT:-0}" ;;
  list)
    if [ "\${STUB_LIST_HAS_BOX:-1}" = "1" ]; then
      printf '{"sandboxes":[{"id":"%s","state":"stopped"}]}\\n' "\${STUB_BOX_ID:-}"
    else
      printf '{"sandboxes":[]}\\n'
    fi
    exit 0 ;;
  ssh | scp)
    remaining="$(cat "$STUB_DIR/restoring" 2>/dev/null || printf 0)"
    if [ "$remaining" != "0" ]; then
      [ "$remaining" -gt 0 ] && printf '%s' "$((remaining - 1))" >"$STUB_DIR/restoring"
      printf '{"code":"%s","error":"restoring","status":409}\\n' "\${STUB_RESTORING_CODE:-boat_restoring}" >&2
      exit 1
    fi
    if [ "$verb" = "ssh" ] && printf '%s' "$*" | grep -q 'test -f.*conductor-run.done'; then
      [ -n "\${STUB_DONE_RESULT:-}" ]
      exit $?
    fi
    if [ "$verb" = "ssh" ] && printf '%s' "$*" | grep -q 'cat.*conductor-run.done'; then
      printf '%s\\n' "\${STUB_DONE_RESULT:-}"
      exit 0
    fi
    if [ "$verb" = "ssh" ] && printf '%s' "$*" | grep -q 'render-detached.sh'; then
      printf 'render-detached: launched\\n'
    fi
    exit 0 ;;
  *) exit 0 ;;
esac
`;

const FLUNCLE_STUB = `#!/usr/bin/env bash
case "$*" in
  *"tracks queue"*)
    [ -n "\${STUB_QUEUE_RESPONSE:-}" ] && printf '%s\\n' "$STUB_QUEUE_RESPONSE"
    [ -n "\${STUB_QUEUE_STDERR:-}" ] && printf '%s\\n' "$STUB_QUEUE_STDERR" >&2
    exit "\${STUB_QUEUE_EXIT_CODE:-0}" ;;
  *"tracks get"*)
    if [ "\${STUB_TRACK_HAS_VIDEO:-0}" = "1" ]; then
      printf '{"track":{"videoUrl":"https://example.invalid/video.mp4"}}\\n'
    else
      printf '{"track":{}}\\n'
    fi ;;
  *"tracks vehicles"*) printf '{"vehicles":[]}\\n' ;;
  *) printf '{}\\n' ;;
esac
`;

// The box runs GNU date (`-d`); the test host is macOS. Preserve every ordinary call and supply
// the one marker parse the conductor needs so completion-state tests exercise the real branch.
const DATE_STUB = `#!/usr/bin/env bash
if [ "\${1:-}" = "-u" ] && [ "\${2:-}" = "-d" ]; then
  printf '4070908800\\n'
  exit 0
fi
if [ "\${1:-}" = "+%s" ] && [ -f "$STUB_DIR/now-sequence" ]; then
  index="$(cat "$STUB_DIR/now-index" 2>/dev/null || printf 1)"
  value="$(sed -n "\${index}p" "$STUB_DIR/now-sequence")"
  [ -n "$value" ] || value="$(tail -n 1 "$STUB_DIR/now-sequence")"
  printf '%s\\n' "$value"
  printf '%s\\n' "$((index + 1))" >"$STUB_DIR/now-index"
  exit 0
fi
exec /bin/date "$@"
`;

// Readiness waits are driven by DATE_STUB's scripted clock. Record the requested intervals
// without delaying the test process, so the harness still proves the production sleep calls.
const SLEEP_STUB = `#!/usr/bin/env bash
printf '%s\n' "$*" >>"$STUB_DIR/sleep-calls"
`;

// `timeout` is coreutils and not on every macOS host, so the fixture supplies its own: it runs
// the bounded command normally, or reports the given exit code WITHOUT running it, which is how
// a resume that outlives its budget is exercised.
const TIMEOUT_STUB = `#!/usr/bin/env bash
secs="\${1:-}"; shift || true
if [ -n "\${STUB_TIMEOUT_EXIT:-}" ]; then
  printf 'timeout %s %s\\n' "$secs" "$*" >>"$STUB_DIR/calls"
  exit "$STUB_TIMEOUT_EXIT"
fi
exec "$@"
`;

// A provision that always fails: most ticks must never reach for a fresh box, and if they do the
// assertions see "provision failed" rather than a silently different path.
const PROVISION_STUB = `#!/usr/bin/env bash
exit 1
`;

function write(path: string, body: string) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/** The stub-driving half of the environment: everything the fixture varies per case. */
function stubEnv(tick: Tick, home: string, stub: string): Record<string, string> {
  // The conductor prefers the BOAT_* names and falls back to the pre-rename BOX_* ones, so a
  // secrets template or operator command cut before the CLI rename keeps working.
  const binAndKey = tick.legacyEnvNames
    ? { BOX_API_KEY: "stub-key", BOX_BIN: join(stub, "boat") }
    : { BOAT_API_KEY: "stub-key", BOAT_BIN: join(stub, "boat") };
  const timeoutExit = tick.timeoutExitCode;
  return {
    ...binAndKey,
    BOAT_READY_INTERVAL: "1",
    BOAT_READY_TIMEOUT: String(tick.readyTimeout ?? 2),
    BUN_BIN: process.execPath,
    CONDUCTOR_ENV: "/dev/null",
    FLUNCLE_API_TOKEN: "stub-token",
    FLUNCLE_API_URL: "http://127.0.0.1:9",
    FLUNCLE_BIN: join(stub, "fluncle"),
    HOME: home,
    PATH: `${stub}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    PROVISION: join(stub, "provision.sh"),
    STUB_BOX_ID: BOX_ID,
    STUB_DIR: stub,
    STUB_DONE_RESULT: tick.doneResult ?? "",
    STUB_LIST_HAS_BOX: (tick.listHasBox ?? true) ? "1" : "0",
    STUB_QUEUE_EXIT_CODE: String(tick.queueExitCode ?? 0),
    STUB_QUEUE_RESPONSE: tick.queueResponse ?? `{"ok":true,"tracks":[{"logId":"${QUEUE_HEAD}"}]}`,
    STUB_QUEUE_STDERR: tick.queueStderr ?? "",
    STUB_RESTORING_CODE: tick.restoringCode ?? "boat_restoring",
    STUB_RESUME_EXIT: String(tick.resumeExitCode ?? 0),
    STUB_TRACK_HAS_VIDEO: tick.trackHasVideo ? "1" : "0",
    ...(timeoutExit === undefined ? {} : { STUB_TIMEOUT_EXIT: String(timeoutExit) }),
  };
}

function runTick(tick: Tick): TickResult {
  const { args = [], initialState = "idle", nowSequence = [], restoringCalls } = tick;
  const root = mkdtempSync(join(tmpdir(), "render-conductor-"));
  try {
    const home = join(root, "home");
    const stub = join(root, "stub");
    const stateDir = join(home, ".render-conductor");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(stub, { recursive: true });
    writeFileSync(join(stub, "restoring"), String(restoringCalls));
    if (nowSequence.length > 0) {
      writeFileSync(join(stub, "now-sequence"), `${nowSequence.join("\n")}\n`);
    }
    write(join(stub, "boat"), BOAT_STUB);
    write(join(stub, "date"), DATE_STUB);
    write(join(stub, "sleep"), SLEEP_STUB);
    write(join(stub, "timeout"), TIMEOUT_STUB);
    write(join(stub, "fluncle"), FLUNCLE_STUB);
    write(join(stub, "provision.sh"), PROVISION_STUB);
    // idle, with a box parked from the last render and no start on the clock — the state a
    // chaining tick lands in right after it parked the box it is about to resume.
    writeFileSync(join(stateDir, "state"), initialState);
    writeFileSync(join(stateDir, "box-id"), BOX_ID);
    if (initialState === "rendering") {
      writeFileSync(join(stateDir, "started-at"), "0");
      writeFileSync(join(stateDir, "render-logid"), QUEUE_HEAD);
    }

    const run = spawnSync("bash", [CONDUCTOR, ...args], {
      encoding: "utf8",
      env: stubEnv(tick, home, stub),
      timeout: SUBPROCESS_TIMEOUT_MS,
    });

    if (run.error || run.signal || run.status === null) {
      throw new Error(
        [
          `render conductor subprocess did not finish within ${SUBPROCESS_TIMEOUT_MS}ms`,
          `error: ${run.error?.message ?? "none"}`,
          `signal: ${run.signal ?? "none"}`,
          `stdout: ${run.stdout ?? ""}`,
          `stderr: ${run.stderr ?? ""}`,
        ].join("\n"),
      );
    }

    const read = (path: string) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    };
    return {
      boxIdFile: read(join(stateDir, "box-id")),
      calls: read(join(stub, "calls")).split("\n").filter(Boolean),
      exitCode: run.status ?? -1,
      log: read(join(stateDir, "conductor.log")),
      noUpdateViolations: read(join(stub, "no-update-violations")).split("\n").filter(Boolean),
      orphans: read(join(stateDir, "orphan-boxes")),
      sleepCalls: read(join(stub, "sleep-calls")).split("\n").filter(Boolean),
      state: read(join(stateDir, "state")),
      stdout: run.stdout ?? "",
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function lastJsonLine(stdout: string): Record<string, unknown> {
  const line = stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) {
    throw new Error("render conductor printed no summary");
  }
  return JSON.parse(line) as Record<string, unknown>;
}

describe("await_box_ready", () => {
  test(
    "a box that restores and then answers renders, and is never condemned",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    () => {
      const tick = runTick({
        nowSequence: [4070908800, 4070908800, 4070908800, 4070908801, 4070908802, 4070908802],
        readyTimeout: 30,
        restoringCalls: 2,
      });

      expect(tick.log).toContain(`box ${BOX_ID} restoring — waiting`);
      expect(tick.log.match(/restoring — waiting/g)).toHaveLength(2);
      expect(tick.log).toContain(`box ${BOX_ID} ready after 2s`);
      expect(tick.sleepCalls).toEqual(["1", "1"]);
      expect(tick.log).not.toContain("condemned");
      expect(tick.orphans.trim()).toBe("");
      expect(tick.boxIdFile).toBe(BOX_ID);
      expect(tick.state).toBe("rendering");
      expect(tick.stdout).toContain(`started render of ${QUEUE_HEAD} on ${BOX_ID}`);
      expect(lastJsonLine(tick.stdout)).toMatchObject({
        checked: 1,
        errors: 0,
        failed: 0,
        produced: 1,
      });
      // The queue read is capped at 25; that page length is not the whole remaining backlog.
      expect("queue_depth" in lastJsonLine(tick.stdout)).toBe(false);
      expect("expected_interval_ms" in lastJsonLine(tick.stdout)).toBe(false);
    },
  );

  // The restoring code is the API's, not the CLI's, so the gate must not be tied to one
  // spelling of it. Each of the three the platform has used has to drive the same wait.
  for (const restoringCode of ["box_restoring", "boat_restoring", "sandbox_restoring"]) {
    test(
      `a box restoring with ${restoringCode} is waited out, not condemned`,
      { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
      () => {
        const tick = runTick({
          nowSequence: [4070908800, 4070908800, 4070908800, 4070908801, 4070908802, 4070908802],
          readyTimeout: 30,
          restoringCalls: 2,
          restoringCode,
        });

        expect(tick.log.match(/restoring — waiting/g)).toHaveLength(2);
        expect(tick.log).not.toContain("something other than a restore");
        expect(tick.log).not.toContain("condemned");
        expect(tick.state).toBe("rendering");
      },
    );
  }

  test(
    "an error that is not a restore ends the wait immediately",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    () => {
      const tick = runTick({
        nowSequence: [4070908800, 4070908800, 4070908800, 4070908801],
        readyTimeout: 30,
        restoringCalls: -1,
        restoringCode: "machine_not_running",
      });

      expect(tick.log).toContain("something other than a restore");
      expect(tick.sleepCalls).toEqual([]);
      expect(tick.log).toContain(`condemned box ${BOX_ID}`);
      expect(tick.state).toBe("idle");
    },
  );

  test(
    "a box that never stops restoring times out from elapsed time and reaches the condemn path",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    () => {
      const tick = runTick({
        nowSequence: [4070908800, 4070908800, 4070908800, 4070908800, 4070908802],
        readyTimeout: 2,
        restoringCalls: -1,
      });

      expect(tick.log).toMatch(new RegExp(`box ${BOX_ID} still restoring after \\d+s — giving up`));
      expect(tick.sleepCalls).toEqual(["1"]);
      expect(tick.log).toContain(`condemned box ${BOX_ID}`);
      expect(tick.orphans).toContain(BOX_ID);
      expect(tick.boxIdFile).toBe("");
      expect(tick.state).toBe("idle");
      expect(tick.stdout).toContain('"ok":false');
      expect(lastJsonLine(tick.stdout)).toMatchObject({
        checked: 1,
        errors: 1,
        failed: 1,
        produced: 0,
      });
    },
  );

  test(
    "a box that answers straight away never logs a duration across a clock boundary",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    () => {
      const tick = runTick({
        nowSequence: [4070908800, 4070908800, 4070908800, 4070908801],
        restoringCalls: 0,
      });

      expect(tick.log).not.toContain("restoring");
      expect(tick.log).not.toContain("ready after");
      expect(tick.state).toBe("rendering");
    },
  );
});

describe("the CLI contract", () => {
  test(
    "every CLI call carries --no-update, so the checksum-pinned binary stays pinned",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    () => {
      const tick = runTick({ restoringCalls: 0 });

      expect(tick.noUpdateViolations).toEqual([]);
      expect(tick.calls.length).toBeGreaterThan(0);
      expect(tick.calls.every((call) => call.startsWith("--no-update "))).toBe(true);
    },
  );

  test(
    "the API key goes in on stdin, never on the command line",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    () => {
      const tick = runTick({ restoringCalls: 0 });

      expect(tick.calls).toContain("--no-update login --key-stdin --json");
      expect(tick.calls.join("\n")).not.toContain("stub-key");
    },
  );

  test(
    "the pre-rename BOX_BIN and BOX_API_KEY names still drive a full tick",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    () => {
      const tick = runTick({ legacyEnvNames: true, restoringCalls: 0 });

      expect(tick.stdout).not.toContain("no BOAT_API_KEY");
      expect(tick.state).toBe("rendering");
      expect(tick.stdout).toContain(`started render of ${QUEUE_HEAD} on ${BOX_ID}`);
    },
  );
});

describe("the bounded resume", () => {
  test(
    "a resume that outlives its budget holds the sandbox id instead of reprovisioning",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    () => {
      // 124 is what `timeout` reports when it kills the command. The sandbox is still listed,
      // so the resume is converging server-side and abandoning the id would strand it.
      const tick = runTick({ listHasBox: true, restoringCalls: 0, timeoutExitCode: 124 });

      expect(tick.exitCode).toBe(0);
      expect(tick.log).toContain(`resume of ${BOX_ID} did not complete (rc=124)`);
      expect(tick.stdout).toContain(`resume of ${BOX_ID} still converging`);
      expect(tick.boxIdFile).toBe(BOX_ID);
      expect(tick.state).toBe("idle");
      expect(tick.log).not.toContain("reprovisioning");
      expect(tick.calls.join("\n")).not.toContain("--no-update new");
    },
  );

  test(
    "a failed resume on a sandbox boat.dev no longer lists reprovisions",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    () => {
      const tick = runTick({ listHasBox: false, restoringCalls: 0, resumeExitCode: 1 });

      expect(tick.log).toContain(`resume of ${BOX_ID} failed (rc=1)`);
      expect(tick.log).toContain("no usable box — reprovisioning");
      // The provision stub always fails, so the tick ends as a run error rather than silently
      // taking some other path.
      expect(tick.exitCode).toBe(1);
      expect(tick.stdout).toContain("render-conductor: provision failed");
    },
  );
});

describe("--preflight", () => {
  test(
    "reports the CLI, the carry-over answer and the pick, and touches nothing",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    () => {
      const tick = runTick({ args: ["--preflight"], restoringCalls: 0 });

      expect(tick.exitCode).toBe(0);
      expect(tick.stdout).toContain("boat 1.0.9");
      expect(tick.stdout).toContain(`carry-over:  YES — ${BOX_ID} is still there`);
      expect(tick.stdout).toContain(
        `queue:       ${QUEUE_HEAD} renderable pick, 0 poisoned skip(s)`,
      );
      expect(tick.stdout).toContain("would do:    nothing");

      // The whole point: read-only. Login and an --all list are the only calls allowed, and the
      // state machine has not moved.
      expect(tick.calls).toEqual([
        "--no-update login --key-stdin --json",
        "--no-update --version",
        "--no-update list --all --json",
      ]);
      expect(tick.state).toBe("idle");
      expect(tick.boxIdFile).toBe(BOX_ID);
    },
  );

  test(
    "says so when the recorded sandbox did not survive the cutover",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    () => {
      const tick = runTick({ args: ["--preflight"], listHasBox: false, restoringCalls: 0 });

      expect(tick.exitCode).toBe(0);
      expect(tick.stdout).toContain(`carry-over:  NO — ${BOX_ID} is not listed`);
      expect(tick.boxIdFile).toBe(BOX_ID);
      expect(tick.state).toBe("idle");
    },
  );

  test("an unknown argument is refused", { timeout: PROCESS_FIXTURE_TIMEOUT_MS }, () => {
    const tick = runTick({ args: ["--wat"], restoringCalls: 0 });

    expect(tick.exitCode).toBe(2);
    expect(tick.calls).toEqual([]);
  });
});

describe("queue read", () => {
  test(
    "a genuinely empty queue is a healthy idle tick",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    () => {
      const tick = runTick({
        queueResponse: '{"ok":true,"tracks":[]}',
        restoringCalls: 0,
      });

      expect(tick.exitCode).toBe(0);
      expect(tick.stdout).toContain("render-conductor: queue empty — nothing to render");
      expect(lastJsonLine(tick.stdout)).toMatchObject({
        checked: 0,
        errors: 0,
        failed: 0,
        ok: true,
        produced: 0,
      });
    },
  );

  test(
    "a failed queue read is a run error, not an empty queue",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    () => {
      const tick = runTick({
        queueExitCode: 7,
        queueResponse: "",
        queueStderr: "transport error",
        restoringCalls: 0,
      });

      expect(tick.exitCode).toBe(1);
      expect(tick.stdout).toContain("render-conductor: queue read failed");
      expect(tick.stdout).not.toContain("queue empty");
      expect(tick.log).toContain("transport error");
      expect(lastJsonLine(tick.stdout)).toMatchObject({
        errors: 1,
        ok: false,
      });
    },
  );

  test(
    "the Worker's typed due-work deferral is a paused tick, not a failure",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    () => {
      const tick = runTick({
        queueExitCode: 1,
        // The CLI pretty-prints its `--json` failure payload.
        queueResponse: JSON.stringify(
          {
            code: "due_work_maintenance_pending",
            message: "Due-work maintenance is still converging",
            ok: false,
          },
          null,
          2,
        ),
        restoringCalls: 0,
      });

      expect(tick.exitCode).toBe(0);
      expect(tick.stdout).toContain("render-conductor: queue read deferred");
      expect(tick.stdout).not.toContain("queue read failed");
      expect(tick.state).toBe("idle");
      expect(lastJsonLine(tick.stdout)).toEqual({
        checked: 0,
        errors: 0,
        failed: 0,
        gateState: "paused",
        ok: true,
        partial: false,
        produced: 0,
        reason: "due_work_repair_pending",
        summary: "render-conductor: queue read deferred — due-work repair still converging",
        throttled: true,
      });
    },
  );

  test(
    "a generic Worker fault in the CLI payload stays a queue-read failure",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    () => {
      const tick = runTick({
        queueExitCode: 1,
        queueResponse: '{"code":"error","message":"Internal error","ok":false}',
        restoringCalls: 0,
      });

      expect(tick.exitCode).toBe(1);
      expect(tick.stdout).toContain("render-conductor: queue read failed");
      expect(lastJsonLine(tick.stdout)).toMatchObject({ errors: 1, ok: false });
    },
  );

  test(
    "a successful error wrapper is a malformed response, not an empty queue",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    () => {
      const tick = runTick({
        queueResponse: '{"ok":false,"error":"rate limited"}',
        restoringCalls: 0,
      });

      expect(tick.exitCode).toBe(1);
      expect(tick.stdout).toContain("render-conductor: queue response malformed");
      expect(tick.stdout).not.toContain("queue empty");
      expect(lastJsonLine(tick.stdout)).toMatchObject({
        errors: 1,
        ok: false,
      });
    },
  );
});

describe("render state counters", () => {
  test(
    "a shipped completion counts the inspected finding and successful completion",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    () => {
      const tick = runTick({
        doneResult: "EXIT=0 @ 2099-01-01T00:00:00Z DURATION=5",
        initialState: "rendering",
        queueResponse: '{"ok":true,"tracks":[]}',
        restoringCalls: 0,
        trackHasVideo: true,
      });

      expect(lastJsonLine(tick.stdout)).toMatchObject({
        checked: 1,
        errors: 0,
        failed: 0,
        produced: 1,
      });
    },
  );

  test(
    "a failed completion stays in failed and does not become a run error",
    { timeout: PROCESS_FIXTURE_TIMEOUT_MS },
    () => {
      const tick = runTick({
        doneResult: "EXIT=7 @ 2099-01-01T00:00:00Z DURATION=5",
        initialState: "rendering",
        queueResponse: '{"ok":true,"tracks":[]}',
        restoringCalls: 0,
      });

      expect(lastJsonLine(tick.stdout)).toMatchObject({
        checked: 1,
        errors: 0,
        failed: 1,
        produced: 0,
      });
    },
  );
});

describe("the provision parser", () => {
  // `boat new --json` is JSONL: `created`, zero or more `state`, then `ready` or `error`
  // (docs.boat.dev/use-in-code). provision-rave-03.sh prefers the `ready` line's id and
  // refuses a run whose last line is an error, so a half-born sandbox is never provisioned
  // against. These fixtures are the documented shapes, verbatim.
  const PROVISION = join(import.meta.dir, "provision-rave-03.sh");

  function parseId(newJson: string): string {
    const root = mkdtempSync(join(tmpdir(), "provision-parse-"));
    try {
      const stub = join(root, "stub");
      mkdirSync(stub, { recursive: true });
      // A `new` that replays the fixture; every other verb succeeds without doing anything, so
      // the script runs to its end and its stdout is exactly the id it resolved — empty when
      // the parse refused the run, because the script then exits before printing anything.
      write(
        join(stub, "boat"),
        `#!/usr/bin/env bash\n[ "\${1:-}" = "--no-update" ] && shift\ncase "\${1:-}" in\n  new) cat "$STUB_DIR/new-json"; exit 0 ;;\n  *) cat >/dev/null 2>&1 || true; exit 0 ;;\nesac\n`,
      );
      writeFileSync(join(stub, "new-json"), newJson);
      const run = spawnSync("bash", [PROVISION], {
        encoding: "utf8",
        env: {
          BOAT_BIN: join(stub, "boat"),
          BUN_BIN: process.execPath,
          PATH: `${stub}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          STUB_DIR: stub,
        },
        timeout: SUBPROCESS_TIMEOUT_MS,
      });
      return run.stdout ?? "";
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }

  test("prefers the ready line's id", { timeout: PROCESS_FIXTURE_TIMEOUT_MS }, () => {
    expect(
      parseId(
        [
          '{"event":"created","id":"bx_8pqt6dup","ttlSeconds":3600}',
          '{"event":"state","id":"bx_8pqt6dup","state":"provisioning"}',
          '{"event":"ready","id":"bx_8pqt6dup","state":"ready","ip":"203.0.113.10"}',
        ].join("\n"),
      ),
    ).toBe("bx_8pqt6dup");
  });

  test("refuses a run that ends in an error event", { timeout: PROCESS_FIXTURE_TIMEOUT_MS }, () => {
    expect(
      parseId(
        [
          '{"event":"created","id":"bx_8pqt6dup","ttlSeconds":3600}',
          '{"event":"error","error":"backend could not provision (409)","code":"resume_failed","status":409}',
        ].join("\n"),
      ),
    ).toBe("");
  });
});

// The conductor is the only consumer of these scripts, and both must stay executable and
// syntactically valid — a bake copies them verbatim to the box.
describe("the scripts themselves", () => {
  for (const script of ["render-conductor.sh", "provision-rave-03.sh"]) {
    test(`${script} parses`, () => {
      const path = join(import.meta.dir, script);
      expect(existsSync(path)).toBe(true);
      const parsed = spawnSync("bash", ["-n", path], { encoding: "utf8" });
      expect(parsed.stderr).toBe("");
      expect(parsed.status).toBe(0);
    });
  }
});
