import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PIN_WATCH = join(import.meta.dir, "..", "pin-watch", "rebuild-hermes.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function extractFunction(source: string, functionName: string): string {
  const start = source.indexOf(`${functionName}() {`);
  if (start < 0) {
    throw new Error(`missing ${functionName}`);
  }

  let depth = 0;
  let opened = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") {
      depth += 1;
      opened = true;
    } else if (character === "}") {
      depth -= 1;
      if (opened && depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  throw new Error(`unterminated ${functionName}`);
}

type Run = {
  calls: string[];
  status: number | null;
  stderr: string;
  stopped: string;
};

function runPinWatch(options: {
  action: "quiesce" | "restore";
  active: readonly string[];
  disableSticks?: boolean;
  stopped?: readonly string[];
}): Run {
  const root = mkdtempSync(join(tmpdir(), "fluncle-pin-watch-dormant-"));
  roots.push(root);
  const repo = join(root, "repo");
  const hermes = join(repo, "docs", "agents", "hermes");
  mkdirSync(join(hermes, "parked-timer"), { recursive: true });
  mkdirSync(join(hermes, "live-timer"), { recursive: true });
  writeFileSync(join(hermes, "parked-timer", "DORMANT"), "parked for a stated reason\n");
  writeFileSync(join(hermes, "parked-timer", "fluncle-parked.timer"), "[Timer]\n");
  writeFileSync(join(hermes, "live-timer", "fluncle-live.timer"), "[Timer]\n");
  const calls = join(root, "calls");
  const state = join(root, "active");
  writeFileSync(calls, "");
  writeFileSync(state, options.active.map((timer) => `${timer}\n`).join(""));
  const source = readFileSync(PIN_WATCH, "utf8");
  const runner = join(root, "runner.sh");

  writeFileSync(
    runner,
    `#!/usr/bin/env bash
set -euo pipefail
ERRORS=0
CONTAINER=hermes
REPO_DIR="${repo}"
REBAKE_LOCK=""
SWEEP_DRAIN_TIMEOUT=0
STOPPED_TIMERS=(${(options.stopped ?? []).map((timer) => `'${timer}'`).join(" ")})
log() { printf '[pin-watch] %s\\n' "$*" >&2; }
die() { ERRORS=1; printf 'FATAL:%s\\n' "$*" >&2; exit 1; }
run_event_now() { printf 'now\\n'; }
docker() { return 0; }
release_order() { printf '%s\\n' "\${STOPPED_TIMERS[@]}"; }
rearm_stalled_timer() { return 1; }
systemctl() {
  printf '%s\\n' "$*" >>"${calls}"
  case "$1" in
    list-units) cat "${state}" ;;
    disable)
      if [ "${options.disableSticks === true ? "1" : "0"}" = "0" ]; then
        grep -vxF "$3" "${state}" >"${state}.next" || true
        mv "${state}.next" "${state}"
      fi
      ;;
    is-enabled | is-active)
      grep -qxF "$3" "${state}"
      return
      ;;
  esac
  return 0
}
${extractFunction(source, "dormant_timer_names")}
${extractFunction(source, "in_timer_list")}
${extractFunction(source, "park_dormant_timer")}
${extractFunction(source, "enforce_dormant_timers")}
${extractFunction(source, "restore_sweep_timers")}
${extractFunction(source, "quiesce_sweeps")}
${options.action === "quiesce" ? "quiesce_sweeps" : "restore_sweep_timers"}
printf '%s\\n' "\${STOPPED_TIMERS[*]:-}" >"${root}/stopped"
exit "$ERRORS"
`,
  );

  const result = spawnSync("bash", [runner], { encoding: "utf8" });
  let stopped = "";
  try {
    stopped = readFileSync(join(root, "stopped"), "utf8").trim();
  } catch {
    stopped = "";
  }

  return {
    calls: readFileSync(calls, "utf8").split("\n").filter(Boolean),
    status: result.status,
    stderr: result.stderr,
    stopped,
  };
}

describe("pin-watch keeps a dormant timer parked", () => {
  test("the quiesce disables a still-active dormant timer and never adds it to the restart set", () => {
    const run = runPinWatch({
      action: "quiesce",
      active: ["fluncle-live.timer", "fluncle-parked.timer"],
    });

    expect(run.status, run.stderr).toBe(0);
    expect(run.calls).toContain("disable --now fluncle-parked.timer");
    expect(run.calls).toContain("stop fluncle-live.timer");
    expect(run.calls).not.toContain("stop fluncle-parked.timer");
    expect(run.stopped).toBe("fluncle-live.timer");
  });

  test("the quiesce aborts the rebuild when a dormant timer will not disable", () => {
    const run = runPinWatch({
      action: "quiesce",
      active: ["fluncle-live.timer", "fluncle-parked.timer"],
      disableSticks: true,
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("could not park dormant timer fluncle-parked.timer");
    expect(run.calls.some((call) => call.startsWith("stop "))).toBe(false);
  });

  test("the restore never restarts a dormant timer, even one in the stopped set", () => {
    const run = runPinWatch({
      action: "restore",
      active: ["fluncle-parked.timer"],
      stopped: ["fluncle-live.timer", "fluncle-parked.timer"],
    });

    expect(run.status, run.stderr).toBe(0);
    expect(run.calls).toContain("start fluncle-live.timer");
    expect(run.calls).not.toContain("start fluncle-parked.timer");
    expect(run.calls).toContain("disable --now fluncle-parked.timer");
  });

  test("a restore whose dormant timer will not disable is recorded as an error", () => {
    const run = runPinWatch({
      action: "restore",
      active: ["fluncle-parked.timer"],
      disableSticks: true,
      stopped: ["fluncle-live.timer", "fluncle-parked.timer"],
    });

    expect(run.status).toBe(1);
    expect(run.calls).toContain("start fluncle-live.timer");
    expect(run.calls).not.toContain("start fluncle-parked.timer");
  });

  test("an already-disabled dormant timer is left alone by the quiesce", () => {
    const run = runPinWatch({ action: "quiesce", active: ["fluncle-live.timer"] });

    expect(run.status, run.stderr).toBe(0);
    expect(run.calls.some((call) => call.startsWith("disable"))).toBe(false);
  });
});
