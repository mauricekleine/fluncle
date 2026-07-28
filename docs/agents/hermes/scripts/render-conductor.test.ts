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
type Tick = { restoringCalls: number; readyTimeout?: number };

type TickResult = {
  boxIdFile: string;
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
    if [ "$verb" = "ssh" ] && printf '%s' "$*" | grep -q 'render-detached.sh'; then
      printf 'render-detached: launched\\n'
    fi
    exit 0 ;;
  *) exit 0 ;;
esac
`;

const FLUNCLE_STUB = `#!/usr/bin/env bash
case "$*" in
  *"tracks queue"*) printf '{"tracks":[{"logId":"${QUEUE_HEAD}"}]}\\n' ;;
  *"tracks vehicles"*) printf '{"vehicles":[]}\\n' ;;
  *) printf '{}\\n' ;;
esac
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

function runTick({ readyTimeout = 2, restoringCalls }: Tick): TickResult {
  const root = mkdtempSync(join(tmpdir(), "render-conductor-"));
  try {
    const home = join(root, "home");
    const stub = join(root, "stub");
    const stateDir = join(home, ".render-conductor");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(stub, { recursive: true });
    writeFileSync(join(stub, "restoring"), String(restoringCalls));
    write(join(stub, "box"), BOX_STUB);
    write(join(stub, "fluncle"), FLUNCLE_STUB);
    write(join(stub, "provision.sh"), PROVISION_STUB);
    // idle, with a box parked from the last render and no start on the clock — the state a
    // chaining tick lands in right after it parked the box it is about to resume.
    writeFileSync(join(stateDir, "state"), "idle");
    writeFileSync(join(stateDir, "box-id"), BOX_ID);

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
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        PROVISION: join(stub, "provision.sh"),
        STUB_DIR: stub,
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
      log: read(join(stateDir, "conductor.log")),
      orphans: read(join(stateDir, "orphan-boxes")),
      state: read(join(stateDir, "state")),
      stdout: run.stdout ?? "",
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
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
  });

  test("a box that never stops restoring times out and still reaches the condemn path", () => {
    const tick = runTick({ readyTimeout: 2, restoringCalls: -1 });

    expect(tick.log).toMatch(/box box-under-test still restoring after \d+s — giving up/);
    expect(tick.log).toContain(`condemned box ${BOX_ID}`);
    expect(tick.orphans).toContain(BOX_ID);
    expect(tick.boxIdFile).toBe("");
    expect(tick.state).toBe("idle");
    expect(tick.stdout).toContain('"ok":false');
  });

  test("a box that answers straight away waits for nothing", () => {
    const tick = runTick({ restoringCalls: 0 });

    expect(tick.log).not.toContain("restoring");
    expect(tick.log).not.toContain("ready after");
    expect(tick.state).toBe("rendering");
  });
});
