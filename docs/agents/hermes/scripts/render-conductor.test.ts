// THE RESTORING WINDOW — the conductor's readiness gate, driven through the REAL script.
//
// WHY THIS TEST EXISTS. `box resume` returns success immediately, but the box then spends a
// few seconds RESTORING, and every call against it in that window 500s with
// `{"code":"box_restoring",…}` — the freshen ssh, both scp refreshes, and the render trigger.
// The trigger's launch-line check read that healthy box as WEDGED and condemned it: measured
// three ticks in a row on 2026-07-27 (17:42Z, 19:44Z, 22:46Z), each costing the hourly slot
// plus a full reprovision. `await_box_ready` waits the window out.
//
// A gate like that is unproven until a synthetic failure makes it fire, so all three cases run
// `render-conductor.sh` itself against a stubbed `box`/`fluncle` in a temp HOME — no network,
// no box.ascii — and assert on what the tick DID:
//
//   1. A box that restores for two probes and then answers → the render starts, nothing is
//      condemned (this is the bug).
//   2. A box that never stops restoring → the wait gives up and the CONDEMN PATH still fires
//      (the wedge authority is unchanged; the gate only buys time).
//   3. A box that answers straight away → no waiting, no noise in the log.
//
//   bun test docs/agents/hermes/scripts/render-conductor.test.ts

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONDUCTOR = join(import.meta.dir, "render-conductor.sh");
const BOX_ID = "box-under-test";
const QUEUE_HEAD = "001.1.1A";

/** `-1` means "restoring forever"; any other count is how many calls 500 before the box answers. */
type Tick = {
  doneResult?: string;
  initialState?: "idle" | "rendering";
  queueExitCode?: number;
  queueResponse?: string;
  queueStderr?: string;
  readyTimeout?: number;
  restoringCalls: number;
  trackHasVideo?: boolean;
};

type TickResult = {
  boxIdFile: string;
  exitCode: number;
  log: string;
  orphans: string;
  state: string;
  stdout: string;
};

// The stub box CLI. It answers the read-only verbs the tick needs (`login`, `list`, `resume`,
// `stop`, `extend`) and fails `ssh`/`scp` with box.ascii's real restoring body until the
// countdown runs out — the same shape the conductor greps for.
const BOX_STUB = `#!/usr/bin/env bash
verb="\${1:-}"; shift || true
printf '%s %s\\n' "$verb" "$*" >>"$STUB_DIR/calls"
case "$verb" in
  list) printf '[]\\n'; exit 0 ;;
  ssh | scp)
    remaining="$(cat "$STUB_DIR/restoring" 2>/dev/null || printf 0)"
    if [ "$remaining" != "0" ]; then
      [ "$remaining" -gt 0 ] && printf '%s' "$((remaining - 1))" >"$STUB_DIR/restoring"
      printf '{"code":"box_restoring","error":"box restoring (500)","status":500}\\n' >&2
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
exec /bin/date "$@"
`;

// A provision that always fails: this tick must never reach for a fresh box, and if it does the
// assertions see "provision failed" rather than a silently different path.
const PROVISION_STUB = `#!/usr/bin/env bash
exit 1
`;

function write(path: string, body: string) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function runTick({
  doneResult = "",
  initialState = "idle",
  queueExitCode = 0,
  queueResponse = `{"ok":true,"tracks":[{"logId":"${QUEUE_HEAD}"}]}`,
  queueStderr = "",
  readyTimeout = 2,
  restoringCalls,
  trackHasVideo = false,
}: Tick): TickResult {
  const root = mkdtempSync(join(tmpdir(), "render-conductor-"));
  try {
    const home = join(root, "home");
    const stub = join(root, "stub");
    const stateDir = join(home, ".render-conductor");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(stub, { recursive: true });
    writeFileSync(join(stub, "restoring"), String(restoringCalls));
    write(join(stub, "box"), BOX_STUB);
    write(join(stub, "date"), DATE_STUB);
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

    const run = spawnSync("bash", [CONDUCTOR], {
      encoding: "utf8",
      env: {
        BOX_API_KEY: "stub-key",
        BOX_BIN: join(stub, "box"),
        BOX_READY_INTERVAL: "1",
        BOX_READY_TIMEOUT: String(readyTimeout),
        BUN_BIN: process.execPath,
        CONDUCTOR_ENV: "/dev/null",
        FLUNCLE_API_TOKEN: "stub-token",
        FLUNCLE_API_URL: "http://127.0.0.1:9",
        FLUNCLE_BIN: join(stub, "fluncle"),
        HOME: home,
        PATH: `${stub}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        PROVISION: join(stub, "provision.sh"),
        STUB_DIR: stub,
        STUB_DONE_RESULT: doneResult,
        STUB_QUEUE_EXIT_CODE: String(queueExitCode),
        STUB_QUEUE_RESPONSE: queueResponse,
        STUB_QUEUE_STDERR: queueStderr,
        STUB_TRACK_HAS_VIDEO: trackHasVideo ? "1" : "0",
      },
      timeout: 60_000,
    });

    const read = (path: string) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    };
    return {
      boxIdFile: read(join(stateDir, "box-id")),
      exitCode: run.status ?? -1,
      log: read(join(stateDir, "conductor.log")),
      orphans: read(join(stateDir, "orphan-boxes")),
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
  test("a box that restores and then answers renders, and is never condemned", () => {
    const tick = runTick({ readyTimeout: 30, restoringCalls: 2 });

    expect(tick.log).toContain(`box ${BOX_ID} restoring — waiting`);
    expect(tick.log).toMatch(/box box-under-test ready after \d+s/);
    // The bug: this tick used to end here instead.
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
  });

  test("a box that never stops restoring times out and still reaches the condemn path", () => {
    const tick = runTick({ readyTimeout: 2, restoringCalls: -1 });

    expect(tick.log).toMatch(/box box-under-test still restoring after \d+s — giving up/);
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
  });

  test("a box that answers straight away waits for nothing", () => {
    const tick = runTick({ restoringCalls: 0 });

    expect(tick.log).not.toContain("restoring");
    expect(tick.log).not.toContain("ready after");
    expect(tick.state).toBe("rendering");
  });
});

describe("queue read", () => {
  test("a genuinely empty queue is a healthy idle tick", () => {
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
  });

  test("a failed queue read is a run error, not an empty queue", () => {
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
  });

  test("a successful error envelope is a malformed response, not an empty queue", () => {
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
  });
});

describe("render state counters", () => {
  test("a shipped completion counts the inspected finding and successful completion", () => {
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
  });

  test("a failed completion stays in failed and does not become a run error", () => {
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
  });
});
