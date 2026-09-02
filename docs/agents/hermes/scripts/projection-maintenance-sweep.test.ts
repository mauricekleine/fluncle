import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type FamilyName,
  fluncleJson,
  runProjectionMaintenanceTick,
} from "./projection-maintenance-sweep";

const family = (overrides: Record<string, unknown> = {}) => ({
  convergence: { epochMatched: true },
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
    const summary = runProjectionMaintenanceTick((args) => {
      calls.push(args);
      return status({});
    });

    expect(calls).toEqual([["admin", "projections", "get"]]);
    expect(summary).toMatchObject({
      checked: 0,
      errors: 0,
      gateState: "disabled",
      ok: true,
      produced: 0,
      reason: "projection_cutovers_disabled",
    });
  });

  test("open idle cutovers prove zero debt without a mutation call", () => {
    const calls: string[][] = [];
    const summary = runProjectionMaintenanceTick((args) => {
      calls.push(args);
      return status({ crawlDueWork: true, publicProjections: true, trackDueWork: true });
    });

    expect(calls).toEqual([["admin", "projections", "get"]]);
    expect(summary).toMatchObject({ checked: 4, errors: 0, gateState: "active", produced: 0 });
    expect(summary.trackDueWork).toMatchObject({ attempted: false, complete: true });
    expect(summary.crawlDueWork).toMatchObject({ attempted: false, complete: true });
    expect(summary.publicAggregates).toMatchObject({ attempted: false, complete: true });
    expect(summary.artistQualification).toMatchObject({ attempted: false, complete: true });
  });
});

describe("projection maintenance bounded family repair", () => {
  test("runs all exact bounded repair commands serially in one tick", () => {
    const calls: string[][] = [];
    const debt = family({
      repairs: {
        direct: { count: 1, truncated: false },
        fanout: { count: 0, truncated: false },
        total: { count: 1, truncated: false },
      },
    });
    const summary = runProjectionMaintenanceTick((args) => {
      calls.push(args);
      if (args[2] === "get") {
        return status(
          { crawlDueWork: true, publicProjections: true, trackDueWork: true },
          { aggregate: debt, artists: debt, crawl: debt, track: debt },
        );
      }
      const target = args[args.indexOf("--target") + 1] as FamilyName;
      return advance(target, false, target === "public_aggregates" ? 9 : 4, 4);
    });

    expect(calls.slice(1)).toEqual(
      (
        [
          ["track_due_work", "20"],
          ["crawl_due_work", "20"],
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
        "--no-terminal-status",
      ]),
    );
    expect(summary).toMatchObject({ checked: 4, errors: 0, ok: true, produced: 21 });
    expect(summary.trackDueWork).toMatchObject({ complete: false, steps: 4 });
    expect(summary.crawlDueWork).toMatchObject({ complete: false, steps: 4 });
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
    runProjectionMaintenanceTick((args) => {
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
    const summary = runProjectionMaintenanceTick((args) => {
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
    expect(summary).toMatchObject({ errors: 1, ok: false, produced: null });
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
      return advance("track_due_work", tick > 1, tick > 1 ? 1 : 100, tick > 1 ? 1 : 20);
    };

    const incomplete = runProjectionMaintenanceTick(run);
    expect(incomplete.trackDueWork).toMatchObject({
      attempted: true,
      complete: false,
      processed: 100,
      steps: 20,
    });
    expect(calls).toHaveLength(2);

    const resumed = runProjectionMaintenanceTick(run);
    expect(resumed.trackDueWork).toMatchObject({
      attempted: true,
      complete: true,
      processed: 1,
      steps: 1,
    });
    expect(calls).toHaveLength(4);
  });

  test("malformed status fails before mutation and malformed advances fail their family", () => {
    const statusCalls: string[][] = [];
    const badStatus = runProjectionMaintenanceTick((args) => {
      statusCalls.push(args);
      return { ok: true, status: {} };
    });
    expect(statusCalls).toHaveLength(1);
    expect(badStatus).toMatchObject({ checked: null, errors: 1, ok: false, produced: null });

    const behind = family({ convergence: { epochMatched: false } });
    const badAdvance = runProjectionMaintenanceTick((args) =>
      args[2] === "get" ? status({ publicProjections: true }, { aggregate: behind }) : { ok: true },
    );
    expect(badAdvance).toMatchObject({ errors: 1, ok: false });
    expect(badAdvance.publicAggregates.error).toMatch(/malformed/);
  });
});
