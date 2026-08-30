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

const status = (open: boolean, aggregate = family(), artists = family()) => ({
  ok: true,
  status: {
    cutovers: { publicProjections: open },
    projections: {
      artistQualification: artists,
      publicAggregates: { anchorsReady: true, ...aggregate },
    },
  },
});

const advance = (target: FamilyName, complete = true, processed = 1) => ({
  action: "repair",
  complete,
  ok: true,
  processed,
  scheduled: 0,
  steps: complete ? 1 : 4,
  target,
});

describe("projection maintenance status gate", () => {
  test("dark means one status read and zero advances", () => {
    const calls: string[][] = [];
    const summary = runProjectionMaintenanceTick((args) => {
      calls.push(args);
      return status(false);
    });

    expect(calls).toEqual([["admin", "projections", "get"]]);
    expect(summary).toMatchObject({
      checked: 0,
      errors: 0,
      gateState: "disabled",
      ok: true,
      produced: 0,
      reason: "public_projection_cutover_disabled",
    });
  });

  test("an open idle cutover makes no mutation call", () => {
    const calls: string[][] = [];
    const summary = runProjectionMaintenanceTick((args) => {
      calls.push(args);
      return status(true);
    });

    expect(calls).toEqual([["admin", "projections", "get"]]);
    expect(summary).toMatchObject({ checked: 2, errors: 0, gateState: "active", produced: 0 });
    expect(summary.publicAggregates).toMatchObject({ attempted: false, complete: true });
    expect(summary.artistQualification).toMatchObject({ attempted: false, complete: true });
  });
});

describe("projection maintenance bounded family repair", () => {
  test("runs both exact bounded repair commands in one tick", () => {
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
        return status(true, debt, debt);
      }
      const target = args[args.indexOf("--target") + 1] as FamilyName;
      return advance(target, false, target === "public_aggregates" ? 9 : 4);
    });

    expect(calls.slice(1)).toEqual(
      (["public_aggregates", "artist_qualification"] as const).map((target) => [
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
        "4",
      ]),
    );
    expect(summary).toMatchObject({ checked: 2, errors: 0, ok: true, produced: 13 });
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
        const response = status(true);
        response.status.projections.publicAggregates.anchorsReady = false;
        return response;
      }
      return advance("public_aggregates");
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("public_aggregates");
  });

  test("one family failure does not starve the other", () => {
    const calls: string[][] = [];
    const behind = family({ convergence: { epochMatched: false } });
    const summary = runProjectionMaintenanceTick((args) => {
      calls.push(args);
      if (args[2] === "get") {
        return status(true, behind, behind);
      }
      const target = args[args.indexOf("--target") + 1];
      if (target === "public_aggregates") {
        throw new Error("aggregate fault");
      }
      return advance("artist_qualification", true, 3);
    });

    expect(calls).toHaveLength(3);
    expect(summary).toMatchObject({ errors: 1, ok: false, produced: null });
    expect(summary.publicAggregates).toMatchObject({
      complete: false,
      error: "aggregate fault",
      processed: null,
      scheduled: null,
      steps: null,
    });
    expect(summary.artistQualification).toMatchObject({ complete: true, processed: 3 });
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
      args[2] === "get" ? status(true, behind) : { ok: true },
    );
    expect(badAdvance).toMatchObject({ errors: 1, ok: false });
    expect(badAdvance.publicAggregates.error).toMatch(/malformed/);
  });
});
