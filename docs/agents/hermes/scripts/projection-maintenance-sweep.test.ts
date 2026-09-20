import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cliAcceptsWallMs,
  type FamilyName,
  fluncleJson,
  runProjectionMaintenanceTick,
} from "./projection-maintenance-sweep";

/**
 * A tick against a CLI that accepts `--wall-ms`, which is the ordinary steady state. The capability
 * probe is stubbed rather than spawned so these cases exercise the tick and not the binary; the
 * probe itself, and the fallback it selects, have their own cases against a real stub CLI below.
 */
const runTick = (
  run: Parameters<typeof runProjectionMaintenanceTick>[0],
  options: Parameters<typeof runProjectionMaintenanceTick>[1] = {},
) => runProjectionMaintenanceTick(run, { acceptsWallMs: () => true, ...options });

const family = (overrides: Record<string, unknown> = {}) => ({
  convergence: { epochMatched: true },
  oldestOutstandingMarkerAge: { ageMs: null, reason: null, truncated: false },
  repairs: {
    direct: { count: 0, truncated: false },
    fanout: { count: 0, truncated: false },
    total: { count: 0, truncated: false },
  },
  ...overrides,
});

const status = (
  cutovers: {
    crawlDueWork?: boolean;
    publicProjections?: boolean;
    trackDueWork?: boolean;
  },
  projectionOverrides: {
    aggregate?: ReturnType<typeof family>;
    artists?: ReturnType<typeof family>;
    crawl?: ReturnType<typeof family>;
    track?: ReturnType<typeof family>;
  } = {},
) => ({
  ok: true,
  status: {
    cutovers: {
      crawlDueWork: cutovers.crawlDueWork ?? false,
      publicProjections: cutovers.publicProjections ?? false,
      trackDueWork: cutovers.trackDueWork ?? false,
    },
    projections: {
      artistQualification: projectionOverrides.artists ?? family(),
      crawlDueWork: projectionOverrides.crawl ?? family(),
      publicAggregates: { anchorsReady: true, ...(projectionOverrides.aggregate ?? family()) },
      trackDueWork: projectionOverrides.track ?? family(),
    },
  },
});

const advance = (target: FamilyName, complete = true, processed = 1, steps = 1) => ({
  action: "repair",
  complete,
  ok: true,
  processed,
  scheduled: 0,
  steps,
  target,
});

describe("projection maintenance status gate", () => {
  test("dark means one status read and zero advances", () => {
    const calls: string[][] = [];
    const summary = runTick((args) => {
      calls.push(args);
      return status({});
    });

    expect(calls).toEqual([["admin", "projections", "get"]]);
    expect(summary).toMatchObject({
      budgetExhaustedFamilies: [],
      checked: 0,
      converged: null,
      errors: 0,
      gateState: "disabled",
      ok: true,
      oldestDebtAgeMs: null,
      produced: 0,
      reason: "projection_cutovers_disabled",
    });
  });

  test("open idle cutovers prove zero debt without a mutation call", () => {
    const calls: string[][] = [];
    const summary = runTick((args) => {
      calls.push(args);
      return status({ crawlDueWork: true, publicProjections: true, trackDueWork: true });
    });

    expect(calls).toEqual([["admin", "projections", "get"]]);
    expect(summary).toMatchObject({
      budgetExhaustedFamilies: [],
      checked: 4,
      converged: true,
      errors: 0,
      gateState: "active",
      oldestDebtAgeMs: null,
      produced: 0,
    });
    expect(summary.trackDueWork).toMatchObject({ attempted: false, complete: true });
    expect(summary.crawlDueWork).toMatchObject({ attempted: false, complete: true });
    expect(summary.publicAggregates).toMatchObject({ attempted: false, complete: true });
    expect(summary.artistQualification).toMatchObject({ attempted: false, complete: true });
  });
});

describe("projection maintenance bounded family repair", () => {
  test("reports no_debt when an enabled family has nothing to repair", () => {
    const summary = runTick(() => status({ trackDueWork: true }));

    expect(summary.trackDueWork).toMatchObject({
      attempted: false,
      outcome: "no_debt",
      processed: 0,
    });
    expect(summary).toMatchObject({
      budgetExhaustedFamilies: [],
      converged: true,
      errors: 0,
      ok: true,
      oldestDebtAgeMs: null,
      outcome: "no_debt",
    });
  });

  test("keeps repairing against an older status response without the optional age field", () => {
    const debt = family({
      oldestOutstandingMarkerAge: undefined,
      repairs: {
        direct: { count: 1, truncated: false },
        fanout: { count: 0, truncated: false },
        total: { count: 1, truncated: false },
      },
    });
    const summary = runTick((args) =>
      args[2] === "get"
        ? status({ trackDueWork: true }, { track: debt })
        : advance("track_due_work"),
    );

    expect(summary.trackDueWork.oldestOutstandingMarkerAge).toEqual({
      ageMs: null,
      reason: "status_field_unavailable",
      truncated: false,
    });
    expect(summary.trackDueWork.outcome).toBe("useful_completion");
  });

  test("reports useful_completion when existing debt drains within the budget", () => {
    const oldestOutstandingMarkerAge = {
      ageMs: 3_600_000,
      reason: null,
      truncated: false,
    };
    const debt = family({
      oldestOutstandingMarkerAge,
      repairs: {
        direct: { count: 1, truncated: false },
        fanout: { count: 0, truncated: false },
        total: { count: 1, truncated: false },
      },
    });
    const summary = runTick((args) =>
      args[2] === "get"
        ? status({ trackDueWork: true }, { track: debt })
        : advance("track_due_work", true, 3),
    );

    expect(summary.trackDueWork).toMatchObject({
      attempted: true,
      oldestOutstandingMarkerAge,
      outcome: "useful_completion",
      processed: 3,
    });
    expect(summary).toMatchObject({
      budgetExhaustedFamilies: [],
      converged: true,
      errors: 0,
      ok: true,
      oldestDebtAgeMs: null,
      outcome: "useful_completion",
    });
  });

  test("reports partial_progress without failing when processed pages exhaust the budget", () => {
    const debt = family({
      oldestOutstandingMarkerAge: { ageMs: 3_600_000, reason: null, truncated: false },
      repairs: {
        direct: { count: 1, truncated: false },
        fanout: { count: 0, truncated: false },
        total: { count: 1, truncated: false },
      },
    });
    const summary = runTick((args) =>
      args[2] === "get"
        ? status({ crawlDueWork: true }, { crawl: debt })
        : advance("crawl_due_work", false, 50, 20),
    );

    expect(summary.crawlDueWork).toMatchObject({
      attempted: true,
      complete: false,
      outcome: "partial_progress",
      processed: 50,
      steps: 20,
    });
    expect(summary).toMatchObject({
      budgetExhaustedFamilies: ["crawl_due_work"],
      converged: false,
      errors: 0,
      ok: true,
      oldestDebtAgeMs: 3_600_000,
      outcome: "partial_progress",
    });
  });

  test("reports no_progress without execution failure when debt spends a budget without processing pages", () => {
    const debt = family({
      repairs: {
        direct: { count: 1, truncated: false },
        fanout: { count: 0, truncated: false },
        total: { count: 1, truncated: false },
      },
    });
    const summary = runTick((args) =>
      args[2] === "get"
        ? status({ trackDueWork: true }, { track: debt })
        : advance("track_due_work", false, 0, 2),
    );

    expect(summary.trackDueWork).toMatchObject({
      attempted: true,
      complete: false,
      outcome: "no_progress",
      processed: 0,
      steps: 2,
    });
    expect(summary).toMatchObject({
      budgetExhaustedFamilies: ["track_due_work"],
      converged: false,
      errors: 0,
      ok: true,
      outcome: "no_progress",
    });
  });

  test("reports the worst attempted family outcome at the top level", () => {
    const debt = family({
      repairs: {
        direct: { count: 1, truncated: false },
        fanout: { count: 0, truncated: false },
        total: { count: 1, truncated: false },
      },
    });
    const summary = runTick((args) => {
      if (args[2] === "get") {
        return status(
          { crawlDueWork: true, publicProjections: true, trackDueWork: true },
          { aggregate: debt, artists: debt, crawl: debt, track: debt },
        );
      }
      const target = args[args.indexOf("--target") + 1] as FamilyName;
      if (target === "track_due_work") {
        return advance(target, true, 1);
      }
      if (target === "crawl_due_work") {
        return advance(target, false, 1, 2);
      }
      if (target === "public_aggregates") {
        return advance(target, false, 0, 2);
      }
      return advance(target, true, 2);
    });

    expect(summary.trackDueWork.outcome).toBe("useful_completion");
    expect(summary.crawlDueWork.outcome).toBe("partial_progress");
    expect(summary.publicAggregates.outcome).toBe("no_progress");
    expect(summary.artistQualification.outcome).toBe("useful_completion");
    expect(summary).toMatchObject({
      budgetExhaustedFamilies: ["crawl_due_work", "public_aggregates"],
      converged: false,
      errors: 0,
      ok: true,
      outcome: "no_progress",
    });
  });

  test("keeps execution healthy while every family exhausts its budget without progress", () => {
    const debt = family({
      repairs: {
        direct: { count: 1, truncated: false },
        fanout: { count: 0, truncated: false },
        total: { count: 1, truncated: false },
      },
    });
    const summary = runTick((args) => {
      if (args[2] === "get") {
        return status(
          { crawlDueWork: true, publicProjections: true, trackDueWork: true },
          { aggregate: debt, artists: debt, crawl: debt, track: debt },
        );
      }
      const target = args[args.indexOf("--target") + 1] as FamilyName;
      return advance(target, false, 0, 2);
    });

    expect(summary).toMatchObject({
      budgetExhaustedFamilies: [
        "track_due_work",
        "crawl_due_work",
        "public_aggregates",
        "artist_qualification",
      ],
      converged: false,
      errors: 0,
      ok: true,
      outcome: "no_progress",
      produced: 0,
    });
  });

  test("runs all exact bounded repair commands serially in one tick", () => {
    const calls: string[][] = [];
    const debt = family({
      repairs: {
        direct: { count: 1, truncated: false },
        fanout: { count: 0, truncated: false },
        total: { count: 1, truncated: false },
      },
    });
    const summary = runTick((args) => {
      calls.push(args);
      if (args[2] === "get") {
        return status(
          { crawlDueWork: true, publicProjections: true, trackDueWork: true },
          { aggregate: debt, artists: debt, crawl: debt, track: debt },
        );
      }
      const target = args[args.indexOf("--target") + 1] as FamilyName;
      return advance(
        target,
        false,
        target === "public_aggregates" ? 9 : 4,
        target.endsWith("due_work") ? 2 : 4,
      );
    });

    // One measured marker per family buys one step for it and one for what lands during the tick;
    // the public families keep their floor, because their epoch and anchor work is not measured in
    // markers at all.
    expect(calls.slice(1)).toEqual(
      (
        [
          ["track_due_work", "2"],
          ["crawl_due_work", "2"],
          ["public_aggregates", "4"],
          ["artist_qualification", "4"],
        ] as const
      ).map(([target, maxSteps]) => [
        "admin",
        "projections",
        "advance",
        "--target",
        target,
        "--action",
        "repair",
        "--limit",
        "500",
        "--max-steps",
        maxSteps,
        "--wall-ms",
        "30000",
        "--no-terminal-status",
      ]),
    );
    expect(summary).toMatchObject({
      budgetExhaustedFamilies: [
        "track_due_work",
        "crawl_due_work",
        "public_aggregates",
        "artist_qualification",
      ],
      checked: 4,
      converged: false,
      errors: 0,
      ok: true,
      produced: 21,
    });
    expect(summary.trackDueWork).toMatchObject({ complete: false, steps: 2 });
    expect(summary.crawlDueWork).toMatchObject({ complete: false, steps: 2 });
    expect(summary.publicAggregates).toMatchObject({ complete: false, steps: 4 });
    expect(summary.artistQualification).toMatchObject({ complete: false, steps: 4 });
    expect(summary).not.toHaveProperty("queue_depth");
    expect(summary).not.toHaveProperty("queueDepth");
  });

  test("rejects malformed output and every nonzero CLI exit", () => {
    const directory = mkdtempSync(join(tmpdir(), "projection-maintenance-"));
    const executable = join(directory, "fluncle");
    const previous = process.env.FLUNCLE_BIN;
    process.env.FLUNCLE_BIN = executable;
    try {
      writeFileSync(executable, "#!/bin/sh\nprintf 'not-json\\n'\n");
      chmodSync(executable, 0o755);
      expect(() => fluncleJson(["admin", "projections", "get"])).toThrow(/without JSON/);

      writeFileSync(executable, "#!/bin/sh\nprintf '{\"ok\":true}\\n'\nexit 2\n");
      expect(() => fluncleJson(["admin", "projections", "get"])).toThrow(/failed/);
    } finally {
      if (previous === undefined) {
        delete process.env.FLUNCLE_BIN;
      } else {
        process.env.FLUNCLE_BIN = previous;
      }
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("an invalid aggregate anchor is repair work even without marker debt", () => {
    const calls: string[][] = [];
    runTick((args) => {
      calls.push(args);
      if (args[2] === "get") {
        const response = status({ publicProjections: true });
        response.status.projections.publicAggregates.anchorsReady = false;
        return response;
      }
      return advance("public_aggregates");
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("public_aggregates");
  });

  test("one family failure does not starve later families", () => {
    const calls: string[][] = [];
    const behind = family({ convergence: { epochMatched: false } });
    const directDebt = family({
      repairs: {
        direct: { count: 2, truncated: false },
        fanout: { count: 0, truncated: false },
        total: { count: 2, truncated: false },
      },
    });
    const summary = runTick((args) => {
      calls.push(args);
      if (args[2] === "get") {
        return status(
          { crawlDueWork: true, publicProjections: true, trackDueWork: true },
          { aggregate: behind, artists: behind, crawl: directDebt, track: directDebt },
        );
      }
      const target = args[args.indexOf("--target") + 1];
      if (target === "track_due_work") {
        throw new Error("track fault");
      }
      return advance(target as FamilyName, true, target === "artist_qualification" ? 3 : 1);
    });

    expect(calls).toHaveLength(5);
    expect(summary).toMatchObject({
      budgetExhaustedFamilies: [],
      converged: false,
      errors: 1,
      ok: false,
      produced: null,
    });
    expect(summary.trackDueWork).toMatchObject({
      complete: false,
      error: "track fault",
      processed: null,
      scheduled: null,
      steps: null,
    });
    expect(summary.crawlDueWork).toMatchObject({ complete: true, processed: 1 });
    expect(summary.publicAggregates).toMatchObject({ complete: true, processed: 1 });
    expect(summary.artistQualification).toMatchObject({ complete: true, processed: 3 });
  });

  test("spends one bounded budget per tick and resumes durable new debt on the next tick", () => {
    const debt = family({
      repairs: {
        direct: { count: 0, truncated: false },
        fanout: { count: 6, truncated: false },
        total: { count: 6, truncated: false },
      },
    });
    const calls: string[][] = [];
    let tick = 0;
    const run = (args: string[]) => {
      calls.push(args);
      if (args[2] === "get") {
        tick += 1;
        return status({ trackDueWork: true }, { track: debt });
      }
      // Six measured markers buy two steps: one page of five plus the headroom step.
      return advance("track_due_work", tick > 1, tick > 1 ? 1 : 100, tick > 1 ? 1 : 2);
    };

    const incomplete = runTick(run);
    expect(incomplete.trackDueWork).toMatchObject({
      attempted: true,
      complete: false,
      processed: 100,
      steps: 2,
    });
    expect(calls).toHaveLength(2);

    const resumed = runTick(run);
    expect(resumed.trackDueWork).toMatchObject({
      attempted: true,
      complete: true,
      processed: 1,
      steps: 1,
    });
    expect(calls).toHaveLength(4);
  });

  test("a truncated debt count spends the step ceiling instead of the count it could see", () => {
    const calls: string[][] = [];
    const truncated = family({
      repairs: {
        direct: { count: 0, truncated: true },
        fanout: { count: 100, truncated: true },
        total: { count: 100, truncated: true },
      },
    });
    runTick((args) => {
      calls.push(args);
      return args[2] === "get"
        ? status({ trackDueWork: true }, { track: truncated })
        : advance("track_due_work", false, 1_400, 100);
    });

    expect(calls[1]?.[calls[1].indexOf("--max-steps") + 1]).toBe("100");
  });

  test("debt older than the escalation bar spends the ceiling even when the count is small", () => {
    const calls: string[][] = [];
    const old = family({
      oldestOutstandingMarkerAge: { ageMs: 10 * 60 * 60_000, reason: null, truncated: false },
      repairs: {
        direct: { count: 0, truncated: false },
        fanout: { count: 3, truncated: false },
        total: { count: 3, truncated: false },
      },
    });
    runTick((args) => {
      calls.push(args);
      return args[2] === "get"
        ? status({ trackDueWork: true }, { track: old })
        : advance("track_due_work", false, 900, 100);
    });

    expect(calls[1]?.[calls[1].indexOf("--max-steps") + 1]).toBe("100");
  });

  test("bounded fresh debt asks for the steps it needs and no more", () => {
    const calls: string[][] = [];
    const bounded = family({
      repairs: {
        direct: { count: 0, truncated: false },
        fanout: { count: 40, truncated: false },
        total: { count: 40, truncated: false },
      },
    });
    runTick((args) => {
      calls.push(args);
      return args[2] === "get"
        ? status({ trackDueWork: true }, { track: bounded })
        : advance("track_due_work", true, 40, 9);
    });

    // Forty markers are eight pages of five, plus the headroom step.
    expect(calls[1]?.[calls[1].indexOf("--max-steps") + 1]).toBe("9");
  });

  test("a public family with an unmatched epoch and no markers still gets its floor", () => {
    const calls: string[][] = [];
    // Zero repair markers, so the count measures none of the work: the epoch mismatch IS the work.
    const epochOnly = family({ convergence: { epochMatched: false } });
    const summary = runTick((args) => {
      calls.push(args);
      if (args[2] === "get") {
        return status({ publicProjections: true }, { aggregate: epochOnly, artists: epochOnly });
      }
      const target = args[args.indexOf("--target") + 1] as FamilyName;
      return advance(target, false, 1, 4);
    });

    for (const call of calls.slice(1)) {
      expect(call[call.indexOf("--max-steps") + 1]).toBe("4");
    }
    expect(summary.publicAggregates.attempted).toBe(true);
    expect(summary.artistQualification.attempted).toBe(true);
  });

  // THE WRITE-LANE SHARE, measured rather than assumed. The adaptive budget moved the worst case
  // per family from 100 markers to 1,400, all inside one whole-lifetime lease, so the ledger needs
  // to be able to answer what share of the write lane maintenance actually takes.
  test("reports the wall time each family's advance held, and the tick's total", () => {
    const debt = family({
      repairs: {
        direct: { count: 1, truncated: false },
        fanout: { count: 0, truncated: false },
        total: { count: 1, truncated: false },
      },
    });
    let clock = 0;
    const summary = runTick(
      (args) => {
        if (args[2] === "get") {
          return status({ crawlDueWork: true, trackDueWork: true }, { crawl: debt, track: debt });
        }
        const target = args[args.indexOf("--target") + 1] as FamilyName;
        clock += target === "track_due_work" ? 4_000 : 1_500;
        return advance(target, true, 1, 2);
      },
      { now: () => clock },
    );

    expect(summary.trackDueWork.leaseHoldMs).toBe(4_000);
    expect(summary.crawlDueWork.leaseHoldMs).toBe(1_500);
    // A family that needed no advance held nothing, and contributes nothing to the total.
    expect(summary.publicAggregates.leaseHoldMs).toBeNull();
    expect(summary.totalLeaseHoldMs).toBe(5_500);
  });

  test("a family whose advance failed still reports what it held", () => {
    const debt = family({
      repairs: {
        direct: { count: 1, truncated: false },
        fanout: { count: 0, truncated: false },
        total: { count: 1, truncated: false },
      },
    });
    let clock = 0;
    const summary = runTick(
      (args) => {
        if (args[2] === "get") {
          return status({ trackDueWork: true }, { track: debt });
        }
        clock += 2_500;
        throw new Error("advance blew up");
      },
      { now: () => clock },
    );

    expect(summary.trackDueWork.leaseHoldMs).toBe(2_500);
    expect(summary.totalLeaseHoldMs).toBe(2_500);
    expect(summary.ok).toBe(false);
  });

  test("the family with the oldest debt is advanced first", () => {
    const withAge = (ageMs: number) =>
      family({
        oldestOutstandingMarkerAge: { ageMs, reason: null, truncated: false },
        repairs: {
          direct: { count: 1, truncated: false },
          fanout: { count: 0, truncated: false },
          total: { count: 1, truncated: false },
        },
      });
    const targets: FamilyName[] = [];
    runTick((args) => {
      if (args[2] === "get") {
        return status(
          { crawlDueWork: true, publicProjections: true, trackDueWork: true },
          {
            aggregate: withAge(40_000),
            artists: withAge(900_000),
            crawl: withAge(10_000),
            track: withAge(120_000),
          },
        );
      }
      const target = args[args.indexOf("--target") + 1] as FamilyName;
      targets.push(target);
      return advance(target, true, 1);
    });

    expect(targets).toEqual([
      "artist_qualification",
      "track_due_work",
      "public_aggregates",
      "crawl_due_work",
    ]);
  });

  test("a family reached with no wall budget left keeps its debt and is not called converged", () => {
    const debt = family({
      oldestOutstandingMarkerAge: { ageMs: 30_000, reason: null, truncated: false },
      repairs: {
        direct: { count: 1, truncated: false },
        fanout: { count: 0, truncated: false },
        total: { count: 1, truncated: false },
      },
    });
    const older = family({
      oldestOutstandingMarkerAge: { ageMs: 600_000, reason: null, truncated: false },
      repairs: {
        direct: { count: 1, truncated: false },
        fanout: { count: 0, truncated: false },
        total: { count: 1, truncated: false },
      },
    });
    const targets: FamilyName[] = [];
    // The clock jumps past the run's wall budget the moment the first family's advance returns.
    let clock = 0;
    const summary = runTick(
      (args) => {
        if (args[2] === "get") {
          return status({ crawlDueWork: true, trackDueWork: true }, { crawl: debt, track: older });
        }
        const target = args[args.indexOf("--target") + 1] as FamilyName;
        targets.push(target);
        clock += 600_000;
        return advance(target, true, 1);
      },
      { now: () => clock },
    );

    expect(targets).toEqual(["track_due_work"]);
    expect(summary.wallDeferredFamilies).toEqual(["crawl_due_work"]);
    expect(summary.crawlDueWork).toMatchObject({ attempted: false, complete: false });
    expect(summary.converged).toBe(false);
    // The deferred family's debt age still reaches the health bar that watches it.
    expect(summary.oldestDebtAgeMs).toBe(30_000);
    expect(summary.errors).toBe(0);
    expect(summary.ok).toBe(true);
  });

  // A KILLED CHILD IS ITS OWN OUTCOME. It reported nothing at all — not a step, not a processed
  // page — while holding the tick's write lease for the whole deadline, so it must not read as the
  // measured zero that `no_progress` means, and it must not take the rest of the tick down with it.
  test("a CLI that runs past its deadline is a timeout, and the other families still report", () => {
    const debt = (ageMs: number) =>
      family({
        oldestOutstandingMarkerAge: { ageMs, reason: null, truncated: false },
        repairs: {
          direct: { count: 1, truncated: false },
          fanout: { count: 0, truncated: false },
          total: { count: 1, truncated: false },
        },
      });
    const directory = mkdtempSync(join(tmpdir(), "projection-maintenance-timeout-"));
    const executable = join(directory, "fluncle");
    const previous = process.env.FLUNCLE_BIN;
    // A stub that answers status instantly and then sleeps past the child deadline on any advance.
    writeFileSync(
      executable,
      `#!/bin/sh
case "$3" in
  get) printf '%s\\n' "$FLUNCLE_STUB_STATUS" ;;
  *) sleep 5 ;;
esac
`,
    );
    chmodSync(executable, 0o755);
    process.env.FLUNCLE_BIN = executable;
    process.env.FLUNCLE_STUB_STATUS = JSON.stringify(
      status({ crawlDueWork: true, trackDueWork: true }, { crawl: debt(10_000), track: debt(0) }),
    );
    try {
      const summary = runTick((args) =>
        // Only the crawl family reaches the real stub; the track family is answered in-process, so
        // one test proves both halves: a timeout stays contained and its neighbour still reports.
        args[args.indexOf("--target") + 1] === "track_due_work"
          ? advance("track_due_work", true, 7, 2)
          : // A one-second deadline against a stub that sleeps five reaches the real kill path in
            // bounded time; the production deadline is the module constant.
            fluncleJson(args, 1_000),
      );

      expect(summary.crawlDueWork).toMatchObject({
        attempted: true,
        complete: false,
        outcome: "timeout",
        processed: null,
        steps: null,
        wallStopped: null,
      });
      expect(summary.crawlDueWork.error).toMatch(/deadline/);
      expect(summary.crawlDueWork.leaseHoldMs).not.toBeNull();
      expect(summary.trackDueWork).toMatchObject({
        complete: true,
        outcome: "useful_completion",
        processed: 7,
      });
      // The worst outcome is the loud one, and the run is a failure for the ledger.
      expect(summary.outcome).toBe("timeout");
      expect(summary.errors).toBe(1);
      expect(summary.ok).toBe(false);
      expect(summary.converged).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.FLUNCLE_BIN;
      } else {
        process.env.FLUNCLE_BIN = previous;
      }
      delete process.env.FLUNCLE_STUB_STATUS;
      rmSync(directory, { force: true, recursive: true });
    }
  }, 30_000);

  test("every family is handed a wall budget, and the tail of the tick is not spent on a stub call", () => {
    const debt = (ageMs: number) =>
      family({
        oldestOutstandingMarkerAge: { ageMs, reason: null, truncated: false },
        repairs: {
          direct: { count: 0, truncated: true },
          fanout: { count: 100, truncated: true },
          total: { count: 100, truncated: true },
        },
      });
    const calls: string[][] = [];
    let clock = 0;
    const summary = runTick(
      (args) => {
        calls.push(args);
        if (args[2] === "get") {
          return status(
            { crawlDueWork: true, trackDueWork: true },
            { crawl: debt(10_000), track: debt(600_000) },
          );
        }
        // The first family spends all but four seconds of the run budget.
        clock += 116_000;
        return advance("track_due_work", false, 1, 100);
      },
      { now: () => clock },
    );

    // The escalated family still asks for the hard step ceiling, but its call is bounded by time.
    expect(calls[1]?.[calls[1].indexOf("--max-steps") + 1]).toBe("100");
    expect(calls[1]?.[calls[1].indexOf("--wall-ms") + 1]).toBe("30000");
    // Four seconds buys roughly one round trip, so the second family waits for the next tick
    // rather than spending the tail on a call that cannot finish a page.
    expect(calls).toHaveLength(2);
    expect(summary.wallDeferredFamilies).toEqual(["crawl_due_work"]);
  });

  test("a family the wall budget stopped reports its steps, pages, and lease hold", () => {
    const debt = family({
      repairs: {
        direct: { count: 1, truncated: false },
        fanout: { count: 0, truncated: false },
        total: { count: 1, truncated: false },
      },
    });
    let clock = 0;
    const summary = runTick(
      (args) => {
        if (args[2] === "get") {
          return status({ trackDueWork: true }, { track: debt });
        }
        clock += 30_000;
        return { ...advance("track_due_work", false, 41, 2), wallStopped: true };
      },
      { now: () => clock },
    );

    expect(summary.trackDueWork).toMatchObject({
      complete: false,
      leaseHoldMs: 30_000,
      outcome: "partial_progress",
      processed: 41,
      steps: 2,
      wallStopped: true,
    });
    // A spent budget is a healthy incomplete tick, not an execution error.
    expect(summary.errors).toBe(0);
    expect(summary.ok).toBe(true);
    expect(summary.budgetExhaustedFamilies).toEqual(["track_due_work"]);
  });

  // The catalogue-rank corpus marker is a resumable REBUILD checkpoint wearing a source-marker row.
  // It can be hours old while every ordinary marker drains, so the server reports it apart from
  // `oldestOutstandingMarkerAge` and the sweep carries it into the ledger under its own name.
  test("the catalogue-rank rebuild marker's age is reported, never folded into debt age", () => {
    const track = family({
      catalogueRankMarkerAgeMs: 14_217_575,
      oldestOutstandingMarkerAge: { ageMs: null, reason: null, truncated: false },
      repairs: {
        direct: { count: 0, truncated: false },
        fanout: { count: 1, truncated: false },
        total: { count: 1, truncated: false },
      },
    });
    const calls: string[][] = [];
    const summary = runTick((args) => {
      calls.push(args);
      return args[2] === "get"
        ? status({ trackDueWork: true }, { track })
        : advance("track_due_work", false, 1, 2);
    });

    expect(summary.catalogueRankMarkerAgeMs).toBe(14_217_575);
    // A four-hour rebuild checkpoint is not four-hour-old debt, so it neither escalates the step
    // ask to the ceiling nor reads as debt the tick failed to drain.
    expect(calls[1]?.[calls[1].indexOf("--max-steps") + 1]).toBe("2");
    expect(summary.oldestDebtAgeMs).toBeNull();
  });

  test("a server that does not report the rank marker is not a malformed status", () => {
    const summary = runTick(() => status({ trackDueWork: true }));

    expect(summary.catalogueRankMarkerAgeMs).toBeNull();
    expect(summary.errors).toBe(0);
  });

  // THE PIN WINDOW IS REAL. This script and the `fluncle` CLI are baked into the same image, but
  // their pins do not move together: a change here rebakes within the hour, while the CLI pin only
  // moves once the release is cut and the pin-drift bump merges. Sending an unknown flag to the old
  // CLI in that window would fail every family — an outage on the drain the flag exists to protect.
  describe("against the CLI pin it is actually bundled with", () => {
    const debt = family({
      // Escalated: an age-driven ask would reach for the 100-step ceiling.
      oldestOutstandingMarkerAge: { ageMs: 10 * 60 * 60_000, reason: null, truncated: false },
      repairs: {
        direct: { count: 0, truncated: true },
        fanout: { count: 100, truncated: true },
        total: { count: 100, truncated: true },
      },
    });

    /** Run one real tick against a stub binary whose help page decides the mode. */
    const withStubCli = <Result>(
      help: string,
      body: (readArgv: () => string[]) => Result,
    ): Result => {
      const directory = mkdtempSync(join(tmpdir(), "projection-maintenance-pin-"));
      const executable = join(directory, "fluncle");
      const argvLog = join(directory, "argv.log");
      const previous = process.env.FLUNCLE_BIN;
      writeFileSync(
        executable,
        `#!/bin/sh
case "$*" in
  *--help*) printf '%s\\n' "$FLUNCLE_STUB_HELP"; exit 0 ;;
esac
case "$3" in
  get) printf '%s\\n' "$FLUNCLE_STUB_STATUS"; exit 0 ;;
esac
printf '%s\\n' "$*" >> "$FLUNCLE_STUB_ARGV"
printf '%s\\n' "$FLUNCLE_STUB_ADVANCE"
`,
      );
      chmodSync(executable, 0o755);
      process.env.FLUNCLE_BIN = executable;
      process.env.FLUNCLE_STUB_HELP = help;
      process.env.FLUNCLE_STUB_ARGV = argvLog;
      process.env.FLUNCLE_STUB_STATUS = JSON.stringify(
        status({ trackDueWork: true }, { track: debt }),
      );
      process.env.FLUNCLE_STUB_ADVANCE = JSON.stringify(advance("track_due_work", false, 12, 2));
      try {
        return body(() =>
          existsSync(argvLog) ? readFileSync(argvLog, "utf8").split("\n").filter(Boolean) : [],
        );
      } finally {
        if (previous === undefined) {
          delete process.env.FLUNCLE_BIN;
        } else {
          process.env.FLUNCLE_BIN = previous;
        }
        delete process.env.FLUNCLE_STUB_HELP;
        delete process.env.FLUNCLE_STUB_ARGV;
        delete process.env.FLUNCLE_STUB_STATUS;
        delete process.env.FLUNCLE_STUB_ADVANCE;
        rmSync(directory, { force: true, recursive: true });
      }
    };

    const MODERN_HELP = "Options:\n  --max-steps <steps>\n  --wall-ms <ms>  Stop issuing steps\n";
    const OLD_HELP = "Options:\n  --max-steps <steps>\n  --no-terminal-status\n";

    test("a CLI that accepts the budget is handed it, and asks for the full ceiling", () => {
      withStubCli(MODERN_HELP, (readArgv) => {
        expect(cliAcceptsWallMs()).toBe(true);
        const summary = runProjectionMaintenanceTick();

        const issued = readArgv();
        expect(issued).toHaveLength(1);
        expect(issued[0]).toContain("--wall-ms 30000");
        expect(issued[0]).toContain("--max-steps 100");
        expect(summary.trackDueWork).toMatchObject({
          attempted: true,
          processed: 12,
          steps: 2,
          wallBound: "wall-ms",
          wallStopped: false,
        });
        expect(summary.errors).toBe(0);
      });
    });

    test("a CLI that predates the budget gets the safe step bound and no unknown flag", () => {
      withStubCli(OLD_HELP, (readArgv) => {
        expect(cliAcceptsWallMs()).toBe(false);
        const summary = runProjectionMaintenanceTick();

        const issued = readArgv();
        expect(issued).toHaveLength(1);
        // The unknown flag would have failed the family outright.
        expect(issued[0]).not.toContain("--wall-ms");
        // Escalation still applies, but to a ceiling that cannot reach the child deadline: 30
        // steps is roughly 36s at the hosted round trip against a 60s deadline.
        expect(issued[0]).toContain("--max-steps 30");
        expect(summary.trackDueWork).toMatchObject({
          attempted: true,
          processed: 12,
          steps: 2,
          wallBound: "steps",
          // An old CLI honours no budget, so this is unknown rather than a false that would read
          // as "the budget was not reached".
          wallStopped: null,
        });
        // The fallback is a slower drain, never an error.
        expect(summary.errors).toBe(0);
        expect(summary.ok).toBe(true);
      });
    });

    test("an unreadable or missing binary falls back rather than guessing forward", () => {
      const previous = process.env.FLUNCLE_BIN;
      process.env.FLUNCLE_BIN = join(tmpdir(), "fluncle-does-not-exist-projection-maintenance");
      try {
        expect(cliAcceptsWallMs()).toBe(false);
      } finally {
        if (previous === undefined) {
          delete process.env.FLUNCLE_BIN;
        } else {
          process.env.FLUNCLE_BIN = previous;
        }
      }
    });
  });

  test("the capability is probed once per run, and never on a tick that advances nothing", () => {
    const debt = family({
      repairs: {
        direct: { count: 1, truncated: false },
        fanout: { count: 0, truncated: false },
        total: { count: 1, truncated: false },
      },
    });
    let probes = 0;
    const acceptsWallMs = () => {
      probes += 1;
      return true;
    };

    runProjectionMaintenanceTick(
      (args) =>
        args[2] === "get"
          ? status({ crawlDueWork: true, trackDueWork: true }, { crawl: debt, track: debt })
          : advance(args[args.indexOf("--target") + 1] as FamilyName, true, 1),
      { acceptsWallMs },
    );
    // Two families advanced; the answer cannot change mid-run, so one probe covers both.
    expect(probes).toBe(1);

    runProjectionMaintenanceTick(() => status({ trackDueWork: true }), { acceptsWallMs });
    // A debt-free tick issues no advance, so it must spawn nothing at all.
    expect(probes).toBe(1);
  });

  test("malformed status fails before mutation and malformed advances fail their family", () => {
    const statusCalls: string[][] = [];
    const badStatus = runTick((args) => {
      statusCalls.push(args);
      return { ok: true, status: {} };
    });
    expect(statusCalls).toHaveLength(1);
    expect(badStatus).toMatchObject({ checked: null, errors: 1, ok: false, produced: null });

    const behind = family({ convergence: { epochMatched: false } });
    const badAdvance = runTick((args) =>
      args[2] === "get" ? status({ publicProjections: true }, { aggregate: behind }) : { ok: true },
    );
    expect(badAdvance).toMatchObject({ errors: 1, ok: false });
    expect(badAdvance.publicAggregates.error).toMatch(/malformed/);
  });
});
