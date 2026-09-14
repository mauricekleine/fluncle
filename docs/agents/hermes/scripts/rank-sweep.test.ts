import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The stub models the two server scopes the driver meets. `other` holds markers of other subjects,
// which the shared repair step pages first; `track` holds track source markers, the only markers
// the rank guard and the post-page drain wait for. `orphan` is repair debt no registered definition
// converges, so the shared step never reports complete. The guard clears five track markers per
// call and refuses with the typed pending answer while more remain; every ranked page appends one
// marker per moved row. `repair-unreported` models a Worker that omits track source-marker state.
const STUB = `#!/bin/bash
DIR="$(dirname "$0")"
ARGS="$*"
read_count() { cat "$1" 2>/dev/null || echo 0; }
increment() {
  local N
  N=$(read_count "$1")
  N=$((N + 1))
  echo "$N" > "$1"
  printf '%s' "$N"
}
take() {
  local HAVE TAKE
  HAVE=$(read_count "$1")
  TAKE=$HAVE
  [ "$TAKE" -le "$2" ] || TAKE=$2
  echo $((HAVE - TAKE)) > "$1"
  printf '%s' "$TAKE"
}
add_markers() {
  local HAVE
  HAVE=$(read_count "$DIR/track")
  echo $((HAVE + $1)) > "$DIR/track"
}
pending() {
  printf '{"code":"due_work_maintenance_pending","message":"Due-work maintenance is still converging","ok":false}\\n'
  exit 1
}
MODE="$(cat "$DIR/mode")"

if [[ "$ARGS" == *"admin projections advance"* ]]; then
  increment "$DIR/repair-count" >/dev/null
  if [ -e "$DIR/repair-invalid" ]; then
    printf '{"action":"repair","ok":true,"steps":1,"target":"track_due_work"}\\n'
    exit 0
  fi
  OTHER=$(take "$DIR/other" 5)
  TRACK=$(take "$DIR/track" $((5 - OTHER)))
  PROCESSED=$((OTHER + TRACK))
  COMPLETE=true
  if [ "$(read_count "$DIR/other")" -gt 0 ] || [ "$(read_count "$DIR/track")" -gt 0 ] \\
    || [ -e "$DIR/orphan" ] || [ "$MODE" = pending ]; then
    COMPLETE=false
  fi
  PENDING=false
  [ "$(read_count "$DIR/track")" -gt 0 ] && PENDING=true
  if [ -e "$DIR/repair-unreported" ]; then
    printf '{"action":"repair","complete":%s,"ok":true,"processed":%s,"scheduled":%s,"steps":1,"target":"track_due_work"}\\n' "$COMPLETE" "$PROCESSED" "$PROCESSED"
  else
    printf '{"action":"repair","complete":%s,"ok":true,"processed":%s,"scheduled":%s,"steps":1,"target":"track_due_work","trackSourceMarkersPending":%s}\\n' "$COMPLETE" "$PROCESSED" "$PROCESSED" "$PENDING"
  fi
  exit 0
fi

N=$(increment "$DIR/rank-count")
case "$MODE" in
  pending) pending ;;
  cli-error) printf '{"code":"missing_token","message":"Missing required env vars","ok":false}\\n'; exit 1 ;;
  crash) printf 'boom\\n' >&2; exit 1 ;;
  missing-remaining) printf '{"ok":true,"summary":{"scored":0}}\\n'; exit 0 ;;
esac

DEBT=$(read_count "$DIR/track")
take "$DIR/track" 5 >/dev/null
[ "$DEBT" -le 5 ] || pending
P=$(increment "$DIR/page-count")

case "$MODE" in
  drain)
    case "$P" in
      1) add_markers 10; printf '{"ok":true,"summary":{"scored":8,"prioritized":1,"quarantined":1,"catalogueDuplicates":3,"remaining":1,"corpus":"60:60"}}\\n' ;;
      2) add_markers 10; printf '{"ok":true,"summary":{"scored":9,"prioritized":1,"quarantined":0,"catalogueDuplicates":2,"remaining":1,"corpus":"60:60"}}\\n' ;;
      *) add_markers 6; printf '{"ok":true,"summary":{"scored":6,"prioritized":0,"quarantined":0,"catalogueDuplicates":0,"remaining":0,"corpus":"60:60"}}\\n' ;;
    esac ;;
  endless) add_markers 10; printf '{"ok":true,"summary":{"scored":10,"prioritized":0,"remaining":9999,"corpus":"60:60"}}\\n' ;;
  crash-after-page)
    if [ "$P" -eq 1 ]; then
      add_markers 10; printf '{"ok":true,"summary":{"scored":10,"prioritized":0,"remaining":9999,"corpus":"60:60"}}\\n'
    else
      printf 'boom\\n' >&2; exit 1
    fi ;;
  idle) printf '{"ok":true,"summary":{"scored":0,"prioritized":0,"remaining":0,"corpus":"60:60"}}\\n' ;;
  flat) add_markers 5; printf '{"ok":true,"scored":4,"prioritized":1,"remaining":0,"corpus":"60:60"}\\n' ;;
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

// Every phase spawns the admission runner, a bun child, and up to two CLI stubs; the longest drains
// run up to the phase cap, so they need more than the default per-test deadline.
const PHASE_DRAIN_TIMEOUT_MS = 60_000;

let dir: string;
let main: typeof import("./rank-sweep").main;
let fluncleJson: typeof import("./rank-sweep").fluncleJson;
let rankPhaseCap: typeof import("./rank-sweep").rankPhaseCap;
let sourceRepairsPerRankGuard: number;

function mode(
  name: string,
  options: {
    orphan?: boolean;
    other?: number;
    repairInvalid?: boolean;
    repairUnreported?: boolean;
    runner?: string;
  } = {},
): void {
  writeFileSync(join(dir, "mode"), name);
  writeFileSync(join(dir, "runner-mode"), options.runner ?? "run");
  writeFileSync(join(dir, "rank-count"), "0");
  writeFileSync(join(dir, "repair-count"), "0");
  writeFileSync(join(dir, "page-count"), "0");
  writeFileSync(join(dir, "track"), "0");
  writeFileSync(join(dir, "other"), String(options.other ?? 0));
  for (const flag of ["orphan", "repair-invalid", "repair-unreported"]) {
    rmSync(join(dir, flag), { force: true });
  }
  if (options.orphan) {
    writeFileSync(join(dir, "orphan"), "");
  }
  if (options.repairInvalid) {
    writeFileSync(join(dir, "repair-invalid"), "");
  }
  if (options.repairUnreported) {
    writeFileSync(join(dir, "repair-unreported"), "");
  }
}

function count(name: "other" | "rank" | "repair" | "track"): number {
  const file = name === "other" || name === "track" ? name : `${name}-count`;
  return Number(readFileSync(join(dir, file), "utf8").trim());
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
  const sweep = await import("./rank-sweep");
  fluncleJson = sweep.fluncleJson;
  main = sweep.main;
  rankPhaseCap = sweep.rankPhaseCap;
  sourceRepairsPerRankGuard = sweep.SOURCE_REPAIRS_PER_RANK_GUARD;
});

afterAll(() => {
  delete process.env.DATABASE_ADMISSION_RUNNER;
  delete process.env.FLUNCLE_ADMISSION_RUNNER_PID;
  delete process.env.FLUNCLE_BIN;
  delete process.env.FLUNCLE_RANK_BATCH;
  delete process.env.FLUNCLE_RANK_MAX_CALLS;
  rmSync(dir, { force: true, recursive: true });
});

describe("rank-sweep phase cap", () => {
  test("a clean default tick and its drain fit the cap with two page drains of slack", () => {
    const phasesPerPage = Math.ceil(250 / sourceRepairsPerRankGuard);
    const cleanWorstCase = 1 + 8 * phasesPerPage;

    expect(sourceRepairsPerRankGuard).toBe(5);
    expect(rankPhaseCap(250, 8)).toBe(500);
    expect(cleanWorstCase).toBe(401);
    expect(rankPhaseCap(250, 8) - cleanWorstCase).toBe(2 * phasesPerPage - 1);
  });

  test("the smallest batch still admits one phase per page and its drain plus slack", () => {
    expect(rankPhaseCap(1, 1)).toBe(3);
    expect(rankPhaseCap(10, 8)).toBe(20);
  });
});

describe("rank-sweep phased drain", () => {
  test(
    "attempts a page every phase, then drains the last page's markers to clean",
    () => {
      mode("drain");
      const summary = run();

      expect(count("rank")).toBe(3);
      expect(count("repair")).toBe(5);
      expect(summary).toMatchObject({
        calls: 3,
        catalogueDuplicates: 5,
        checked: 26,
        drainComplete: true,
        drainPhases: 2,
        ok: true,
        partial: false,
        prioritized: 2,
        quarantined: 1,
        rankPending: 0,
        reason: null,
        remaining: 0,
        repairSteps: 5,
        scored: 23,
        trackRepairQueueComplete: true,
      });
      expect(count("track")).toBe(0);
    },
    PHASE_DRAIN_TIMEOUT_MS,
  );

  test(
    "ranks all eight configured pages, then drains the eighth page to clean",
    () => {
      mode("endless");
      const summary = run();

      expect(count("rank")).toBe(8);
      expect(count("repair")).toBe(10);
      expect(summary).toMatchObject({
        calls: 8,
        checked: 80,
        drainComplete: true,
        drainPhases: 2,
        ok: true,
        partial: true,
        rankPending: 0,
        reason: "rank_page_budget",
        remaining: 9999,
        repairSteps: 10,
        throttled: false,
      });
      expect(count("track")).toBe(0);
    },
    PHASE_DRAIN_TIMEOUT_MS,
  );

  test(
    "a stuck unrelated repair row never holds back a rank page or the drain",
    () => {
      mode("endless", { orphan: true });
      const summary = run();

      expect(count("rank")).toBe(8);
      expect(summary).toMatchObject({
        calls: 8,
        drainComplete: true,
        ok: true,
        rankPending: 0,
        reason: "rank_page_budget",
        repairSteps: 10,
        trackRepairQueueComplete: false,
      });
    },
    PHASE_DRAIN_TIMEOUT_MS,
  );

  test(
    "the worst clean tick and its drain fit inside the cap when repair spends pages elsewhere",
    () => {
      // Exactly enough other-subject markers to absorb every ride-along step until page eight.
      mode("endless", { other: 75 });
      const summary = run();

      // Page one, two phases per later page (the guard clears five markers and refuses, then clears
      // the last five and reads), then two drain phases.
      expect(count("rank")).toBe(15);
      expect(count("repair")).toBe(17);
      expect(summary).toMatchObject({
        calls: 8,
        drainComplete: true,
        drainPhases: 2,
        ok: true,
        rankPending: 7,
        reason: "rank_page_budget",
        repairSteps: 1 + 8 * Math.ceil(10 / sourceRepairsPerRankGuard),
      });
      expect(Number(summary.repairSteps)).toBeLessThan(rankPhaseCap(10, 8));
    },
    PHASE_DRAIN_TIMEOUT_MS,
  );

  test(
    "a drain that cannot clear ends on the phase cap with no further rank attempt",
    () => {
      mode("endless", { other: 1000 });
      const summary = run();

      expect(count("rank")).toBe(15);
      expect(count("repair")).toBe(rankPhaseCap(10, 8));
      expect(summary).toMatchObject({
        calls: 8,
        drainComplete: false,
        drainPhases: rankPhaseCap(10, 8) - 15,
        ok: true,
        partial: true,
        reason: "drain_phase_budget",
        remaining: 9999,
        repairSteps: rankPhaseCap(10, 8),
      });
    },
    PHASE_DRAIN_TIMEOUT_MS,
  );

  test(
    "a drain cut by the wall budget reports a partial tick",
    () => {
      mode("drain", { other: 1000 });
      // The clock reaches the budget once two drain phases have run after the three rank pages.
      const now = spyOn(performance, "now").mockImplementation(() =>
        count("repair") >= 7 ? 600_000 : 0,
      );

      try {
        const summary = run();

        expect(count("rank")).toBe(5);
        expect(count("repair")).toBe(7);
        expect(summary).toMatchObject({
          calls: 3,
          drainComplete: false,
          drainPhases: 2,
          errors: 0,
          ok: true,
          partial: true,
          reason: "drain_wall_budget",
          remaining: 1,
          throttled: false,
        });
        expect(count("track")).toBeGreaterThan(0);
      } finally {
        now.mockRestore();
      }
    },
    PHASE_DRAIN_TIMEOUT_MS,
  );

  test(
    "a repair step that does not report track source markers cannot prove the drain",
    () => {
      mode("flat", { repairUnreported: true });
      const summary = run();

      expect(count("rank")).toBe(1);
      expect(count("repair")).toBe(2);
      expect(summary).toMatchObject({
        drainComplete: false,
        drainPhases: 1,
        ok: true,
        partial: true,
        reason: "drain_unverified",
      });
    },
    PHASE_DRAIN_TIMEOUT_MS,
  );

  test(
    "a guard that never clears ends on the phase cap with one rank attempt per phase",
    () => {
      mode("pending");
      const summary = run();

      expect(count("rank")).toBe(rankPhaseCap(10, 8));
      expect(count("repair")).toBe(rankPhaseCap(10, 8));
      expect(summary).toMatchObject({
        calls: 0,
        drainComplete: null,
        drainPhases: 0,
        errors: 0,
        ok: true,
        partial: true,
        rankPending: rankPhaseCap(10, 8),
        reason: "rank_phase_budget",
        remaining: 1,
        repairSteps: rankPhaseCap(10, 8),
        throttled: true,
        trackRepairQueueComplete: false,
      });
    },
    PHASE_DRAIN_TIMEOUT_MS,
  );

  test(
    "a guard that never clears ends on the wall budget before another phase starts",
    () => {
      mode("pending");
      // Each completed phase advances the monotonic clock by a third of the budget.
      const now = spyOn(performance, "now").mockImplementation(() => count("repair") * 200_000);

      try {
        const summary = run();

        expect(count("rank")).toBe(3);
        expect(count("repair")).toBe(3);
        expect(summary).toMatchObject({
          calls: 0,
          errors: 0,
          ok: true,
          partial: true,
          rankPending: 3,
          reason: "rank_wall_budget",
          remaining: 1,
          repairSteps: 3,
          throttled: true,
        });
      } finally {
        now.mockRestore();
      }
    },
    PHASE_DRAIN_TIMEOUT_MS,
  );

  test("stops on the monotonic wall budget before starting a phase", () => {
    mode("idle");
    const now = spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(600_000);

    try {
      const summary = run();

      expect(count("rank")).toBe(0);
      expect(count("repair")).toBe(0);
      expect(summary).toMatchObject({
        calls: 0,
        partial: true,
        reason: "rank_wall_budget",
        repairSteps: 0,
        throttled: false,
        trackRepairQueueComplete: null,
      });
      expect(summary.remaining).toBeGreaterThan(0);
    } finally {
      now.mockRestore();
    }
  });

  test("an unchanged archive is one repair step and one no-op rank call with nothing to drain", () => {
    mode("idle");
    const summary = run();

    expect(count("rank")).toBe(1);
    expect(count("repair")).toBe(1);
    expect(summary).toMatchObject({
      checked: 0,
      drainComplete: null,
      drainPhases: 0,
      ok: true,
      partial: false,
      remaining: 0,
      trackRepairQueueComplete: true,
    });
  });

  test("the flat rank payload remains compatible and its page is drained", () => {
    mode("flat");
    const summary = run();

    expect(count("rank")).toBe(1);
    expect(count("repair")).toBe(2);
    expect(summary).toMatchObject({
      drainComplete: true,
      drainPhases: 1,
      ok: true,
      partial: false,
      prioritized: 1,
      remaining: 0,
      scored: 4,
    });
  });

  test("a phase yield stops without replay and reports healthy backpressure", () => {
    mode("idle", { runner: "yield" });
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

  test("a malformed repair response fails the phase before any rank attempt", () => {
    mode("endless", { repairInvalid: true });
    const summary = run();

    expect(count("repair")).toBe(1);
    expect(count("rank")).toBe(0);
    expect(summary).toMatchObject({ calls: 0, errors: 1, ok: false, remaining: 1 });
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
        drainPhases: 0,
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
        throttled: true,
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

  test("a transport failure on the first rank call fails the tick", () => {
    mode("crash");
    const summary = run();

    expect(count("repair")).toBe(1);
    expect(count("rank")).toBe(1);
    expect(summary).toMatchObject({ calls: 0, errors: 1, ok: false, remaining: 1 });
  });

  test(
    "an ambiguous rank transport after a ranked page is never replayed",
    () => {
      mode("crash-after-page");
      const summary = run();

      expect(count("rank")).toBe(2);
      expect(count("repair")).toBe(2);
      expect(summary).toMatchObject({
        calls: 1,
        drainPhases: 0,
        errors: 1,
        ok: false,
        remaining: 9999,
      });
    },
    PHASE_DRAIN_TIMEOUT_MS,
  );

  test("a non-pending rank error fails the tick after one attempt", () => {
    mode("cli-error");
    const summary = run();

    expect(count("repair")).toBe(1);
    expect(count("rank")).toBe(1);
    expect(summary).toMatchObject({ calls: 0, errors: 1, ok: false });
  });
});
