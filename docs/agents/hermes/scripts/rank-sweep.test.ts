import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STUB = `#!/bin/bash
DIR="$(dirname "$0")"
ARGS="$*"
increment() {
  local FILE="$1" N
  N=$(cat "$FILE" 2>/dev/null || echo 0)
  N=$((N + 1))
  echo "$N" > "$FILE"
  printf '%s' "$N"
}
add_debt() {
  local ADDED="$1" DEBT
  DEBT=$(cat "$DIR/debt" 2>/dev/null || echo 0)
  echo $((DEBT + ADDED)) > "$DIR/debt"
}

if [[ "$ARGS" == *"admin projections advance"* ]]; then
  increment "$DIR/repair-count" >/dev/null
  DEBT=$(cat "$DIR/debt" 2>/dev/null || echo 0)
  PROCESSED=$DEBT
  [ "$PROCESSED" -le 5 ] || PROCESSED=5
  DEBT=$((DEBT - PROCESSED))
  echo "$DEBT" > "$DIR/debt"
  if [ "$DEBT" -eq 0 ]; then COMPLETE=true; else COMPLETE=false; fi
  printf '{"action":"repair","complete":%s,"ok":true,"processed":%s,"scheduled":%s,"steps":1,"target":"track_due_work"}\n' "$COMPLETE" "$PROCESSED" "$PROCESSED"
  exit 0
fi

N=$(increment "$DIR/rank-count")
case "$(cat "$DIR/mode")" in
  drain)
    case "$N" in
      1) add_debt 10; printf '{"ok":true,"summary":{"scored":8,"prioritized":1,"quarantined":1,"catalogueDuplicates":3,"remaining":1,"corpus":"60:60"}}\n' ;;
      2) add_debt 10; printf '{"ok":true,"summary":{"scored":9,"prioritized":1,"quarantined":0,"catalogueDuplicates":2,"remaining":1,"corpus":"60:60"}}\n' ;;
      *) add_debt 6; printf '{"ok":true,"summary":{"scored":6,"prioritized":0,"quarantined":0,"catalogueDuplicates":0,"remaining":0,"corpus":"60:60"}}\n' ;;
    esac ;;
  endless) add_debt 10; printf '{"ok":true,"summary":{"scored":10,"prioritized":0,"remaining":9999,"corpus":"60:60"}}\n' ;;
  idle) printf '{"ok":true,"summary":{"scored":0,"prioritized":0,"remaining":0,"corpus":"60:60"}}\n' ;;
  flat) add_debt 5; printf '{"ok":true,"scored":4,"prioritized":1,"remaining":0,"corpus":"60:60"}\n' ;;
  pending) printf '{"code":"due_work_maintenance_pending","message":"Due-work maintenance is still converging","ok":false}\n'; exit 1 ;;
  cli-error) printf '{"code":"missing_token","message":"Missing required env vars","ok":false}\n'; exit 1 ;;
  crash) printf 'boom\n' >&2; exit 1 ;;
  missing-remaining) printf '{"ok":true,"summary":{"scored":0}}\n' ;;
esac
`;

const RUNNER = `#!/bin/bash
DIR="$(dirname "$0")"
if [ "$(cat "$DIR/runner-mode")" = "yield" ]; then
  exit 75
fi
[ "$1" = "phase" ] && shift
shift
[ "$1" = "--" ] && shift
exec "$@"
`;

let dir: string;
let main: typeof import("./rank-sweep").main;
let fluncleJson: typeof import("./rank-sweep").fluncleJson;

function mode(name: string, runnerMode = "run"): void {
  writeFileSync(join(dir, "mode"), name);
  writeFileSync(join(dir, "runner-mode"), runnerMode);
  writeFileSync(join(dir, "rank-count"), "0");
  writeFileSync(join(dir, "repair-count"), "0");
  writeFileSync(join(dir, "debt"), "0");
}

function count(name: "rank" | "repair"): number {
  return Number(readFileSync(join(dir, `${name}-count`), "utf8").trim());
}

function run(): Record<string, unknown> {
  const lines: string[] = [];
  const consoleLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    main();
  } finally {
    console.log = consoleLog;
  }
  return JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "rank-sweep-"));
  const bin = join(dir, "fluncle");
  const runner = join(dir, "database-admission-runner.sh");
  writeFileSync(bin, STUB);
  writeFileSync(runner, RUNNER);
  chmodSync(bin, 0o755);
  chmodSync(runner, 0o755);
  process.env.FLUNCLE_BIN = bin;
  process.env.DATABASE_ADMISSION_RUNNER = runner;
  process.env.FLUNCLE_RANK_BATCH = "10";
  process.env.FLUNCLE_RANK_MAX_CALLS = "8";
  mode("idle");
  ({ fluncleJson, main } = await import("./rank-sweep"));
});

afterAll(() => {
  delete process.env.DATABASE_ADMISSION_RUNNER;
  delete process.env.FLUNCLE_ADMISSION_RUNNER_PID;
  delete process.env.FLUNCLE_BIN;
  delete process.env.FLUNCLE_RANK_BATCH;
  delete process.env.FLUNCLE_RANK_MAX_CALLS;
  rmSync(dir, { force: true, recursive: true });
});

describe("rank-sweep phased drain", () => {
  test("drains maintenance between two full pages and cleans the final short page", () => {
    mode("drain");
    const summary = run();

    expect(count("rank")).toBe(3);
    expect(count("repair")).toBe(7);
    expect(summary).toMatchObject({
      calls: 3,
      catalogueDuplicates: 5,
      checked: 26,
      maintenanceComplete: true,
      ok: true,
      partial: false,
      prioritized: 2,
      quarantined: 1,
      remaining: 0,
      repairPhases: 7,
      scored: 23,
    });
  });

  test("runs all eight configured pages and still drains page eight's marker fanout", () => {
    mode("endless");
    const summary = run();

    expect(count("rank")).toBe(8);
    expect(count("repair")).toBe(17);
    expect(summary).toMatchObject({
      calls: 8,
      checked: 80,
      maintenanceComplete: true,
      ok: true,
      partial: true,
      reason: "rank_page_budget",
      remaining: 9999,
      repairPhases: 17,
    });
    expect(readFileSync(join(dir, "debt"), "utf8").trim()).toBe("0");
  });

  test("bounds initial maintenance debt before any rank page starts", () => {
    mode("idle");
    writeFileSync(join(dir, "debt"), "100");
    const summary = run();

    expect(count("rank")).toBe(0);
    expect(count("repair")).toBe(17);
    expect(summary).toMatchObject({
      calls: 0,
      maintenanceComplete: false,
      partial: true,
      reason: "repair_phase_budget",
      repairPhases: 17,
    });
    expect(summary.remaining).toBeGreaterThan(0);
    expect(readFileSync(join(dir, "debt"), "utf8").trim()).toBe("15");
  });

  test("stops on the monotonic wall budget before starting a phase", () => {
    mode("idle");
    const now = spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(600_000);

    try {
      const summary = run();

      expect(count("rank")).toBe(0);
      expect(count("repair")).toBe(0);
      expect(summary).toMatchObject({
        calls: 0,
        maintenanceComplete: false,
        partial: true,
        reason: "rank_wall_budget",
        repairPhases: 0,
      });
      expect(summary.remaining).toBeGreaterThan(0);
    } finally {
      now.mockRestore();
    }
  });

  test("an unchanged archive is one repair proof and one no-op rank call", () => {
    mode("idle");
    const summary = run();

    expect(count("rank")).toBe(1);
    expect(count("repair")).toBe(1);
    expect(summary).toMatchObject({
      checked: 0,
      maintenanceComplete: true,
      ok: true,
      remaining: 0,
    });
  });

  test("the flat rank payload remains compatible and its writes are cleaned", () => {
    mode("flat");
    const summary = run();

    expect(count("rank")).toBe(1);
    expect(count("repair")).toBe(2);
    expect(summary).toMatchObject({ maintenanceComplete: true, prioritized: 1, scored: 4 });
  });

  test("a phase yield stops without replay and reports healthy backpressure", () => {
    mode("idle", "yield");
    const summary = run();

    expect(count("rank")).toBe(0);
    expect(count("repair")).toBe(0);
    expect(summary).toMatchObject({
      admissionOutcome: "phase-yielded",
      calls: 0,
      ok: true,
      partial: true,
      reason: "database_admission",
      remaining: 1,
      throttled: true,
    });
  });

  test("typed maintenance pending is a healthy partial result", () => {
    mode("pending");
    const summary = run();

    expect(count("rank")).toBe(1);
    expect(count("repair")).toBe(1);
    expect(summary).toMatchObject({
      calls: 0,
      errors: 0,
      ok: true,
      partial: true,
      reason: "due_work_maintenance_pending",
      remaining: 1,
      throttled: true,
    });
  });

  test("a missing remaining sentinel fails instead of claiming an empty queue", () => {
    mode("missing-remaining");
    const summary = run();

    expect(summary).toMatchObject({ errors: 1, ok: false, remaining: 1 });
  });
});

describe("rank-sweep rolling compatibility", () => {
  test("an inherited whole-lifetime lease makes one nonnested rank request", () => {
    mode("drain");
    process.env.FLUNCLE_ADMISSION_RUNNER_PID = "old-runner";
    try {
      const summary = run();
      expect(count("rank")).toBe(1);
      expect(count("repair")).toBe(0);
      expect(summary).toMatchObject({
        calls: 1,
        ok: true,
        partial: true,
        reason: "rolling_admission_compatibility",
        remaining: 1,
      });
    } finally {
      delete process.env.FLUNCLE_ADMISSION_RUNNER_PID;
    }
  });

  test("an inherited lease treats typed maintenance pending as healthy partial", () => {
    mode("pending");
    process.env.FLUNCLE_ADMISSION_RUNNER_PID = "old-runner";
    try {
      const summary = run();
      expect(count("rank")).toBe(1);
      expect(count("repair")).toBe(0);
      expect(summary).toMatchObject({
        calls: 0,
        errors: 0,
        ok: true,
        reason: "due_work_maintenance_pending",
        remaining: 1,
      });
    } finally {
      delete process.env.FLUNCLE_ADMISSION_RUNNER_PID;
    }
  });
});

describe("rank-sweep fluncle transport", () => {
  test("throws on the CLI's own non-maintenance error payload", () => {
    mode("cli-error");
    expect(() => fluncleJson(["admin", "catalogue", "rank"])).toThrow(/Missing required env vars/);
  });

  test("throws when the CLI crashes without parseable JSON", () => {
    mode("crash");
    expect(() => fluncleJson(["admin", "catalogue", "rank"])).toThrow(/exited 1/);
  });

  test("a transport failure remains a failed tick", () => {
    mode("crash");
    const summary = run();

    expect(summary).toMatchObject({ errors: 1, ok: false, remaining: 1 });
  });
});
