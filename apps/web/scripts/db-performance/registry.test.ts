import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";

import { selectPerformanceContracts } from "./contracts";
import { applyFixtureSchema, writeFixture } from "./fixture";
import { createCiFixtureCounts } from "./manifest";
import {
  PerformanceRegistry,
  type PerformanceClient,
  runPerformanceContracts,
  sqlContract,
} from "./registry";

const NOOP_CLIENT: PerformanceClient = {
  async execute() {
    return { rows: [] };
  },
};

describe("performance registry", () => {
  it("requires bounded stable unique contract IDs", () => {
    const registry = new PerformanceRegistry();
    const contract = {
      description: "semantic pin",
      async execute() {
        return { resultRowCount: 0 };
      },
      id: "queue.semantic-pin",
      iterations: 1,
      workClass: "queue" as const,
    };

    registry.register(contract);
    expect(registry.get(contract.id)).toBe(contract);
    expect(() => registry.get("queue.unknown")).toThrow("unknown performance contract");
    expect(() => registry.register(contract)).toThrow("duplicate performance contract id");
    expect(() => registry.register({ ...contract, id: "Not stable" })).toThrow(
      "invalid performance contract id",
    );
  });

  it("reports deterministic p50/p95/p99, row counts, and budget failures", async () => {
    const durations = [10, 20, 30, 40, 300];
    const report = await runPerformanceContracts({
      client: NOOP_CLIENT,
      contracts: [
        {
          description: "queue budget pin",
          async execute({ iteration }) {
            return {
              affectedRowCount: iteration + 2,
              batchCount: iteration + 3,
              durationMs: durations[iteration] ?? 0,
              queueMs: iteration,
              resultRowCount: iteration + 1,
            };
          },
          id: "queue.budget-pin",
          iterations: durations.length,
          workClass: "queue",
        },
      ],
      generatedAt: "2026-01-01T00:00:00.000Z",
      profile: "2x",
    });
    const contract = report.contracts[0];

    expect(contract?.durationMs).toEqual({ max: 300, p50: 30, p95: 300, p99: 300 });
    expect(contract?.queueMs).toEqual({ max: 4, p50: 2, p95: 4, p99: 4 });
    expect(contract?.resultRowCount).toEqual({ max: 5, p50: 3, p95: 5, p99: 5 });
    expect(contract?.affectedRowCount).toEqual({ max: 6, p50: 4, p95: 6, p99: 6 });
    expect(contract?.batchCount).toEqual({ max: 7, p50: 5, p95: 7, p99: 7 });
    expect(contract?.budget.failures).toContain("p95 300ms exceeds 250ms");
    expect(report.passed).toBe(false);
    expect(() => JSON.parse(JSON.stringify(report))).not.toThrow();
  });

  it("reports a 4x timing miss as a warning rather than a required-budget failure", async () => {
    const report = await runPerformanceContracts({
      client: NOOP_CLIENT,
      contracts: [
        {
          description: "4x warning pin",
          async execute() {
            return { durationMs: 900, resultRowCount: 1 };
          },
          id: "route.warning-pin",
          iterations: 1,
          workClass: "route-db",
        },
      ],
      profile: "4x",
    });

    expect(report.contracts[0]?.budget.required).toBe(false);
    expect(report.contracts[0]?.budget.failures).toEqual([]);
    expect(report.contracts[0]?.budget.warnings).toContain("p95 900ms exceeds 250ms");
    expect(report.passed).toBe(true);
  });

  it("fails an EQP full scan or temporary sort independently of timing", async () => {
    const client: PerformanceClient = {
      async execute(statement) {
        const sql = typeof statement === "string" ? statement : statement.sql;

        if (sql.startsWith("EXPLAIN QUERY PLAN")) {
          return {
            rows: [{ detail: "SCAN perf_tracks" }, { detail: "USE TEMP B-TREE FOR ORDER BY" }],
          };
        }

        return { rows: [{ id: "synthetic-track-000000001" }] };
      },
    };
    const contract = sqlContract({
      description: "bad plan fixture",
      id: "route.bad-plan",
      iterations: 1,
      plan: {
        policy: { forbidTempSort: true, growingTables: ["perf_tracks"] },
        statement: { args: [], sql: "select id from perf_tracks order by title" },
      },
      statement: { args: [], sql: "select id from perf_tracks order by title" },
      workClass: "route-db",
    });
    let clock = 0;
    const report = await runPerformanceContracts({
      client,
      contracts: [contract],
      now: () => clock++,
      profile: "1x",
    });

    expect(report.contracts[0]?.plan?.fullScans[0]?.table).toBe("perf_tracks");
    expect(report.contracts[0]?.plan?.tempSorts).toHaveLength(1);
    expect(report.contracts[0]?.plan?.violations).toHaveLength(2);
    expect(report.contracts[0]?.passed).toBe(false);
  });

  it("runs the registered lightweight contract at 1x, 2x, and 4x without the million-row fixture", async () => {
    const client = createClient({ url: ":memory:" });

    try {
      await applyFixtureSchema(client);
      const counts = createCiFixtureCounts("1x", 256);
      await writeFixture(client, "1x", { counts });

      expect(counts.tracks).toBe(256);
      for (const profile of ["1x", "2x", "4x"] as const) {
        const report = await runPerformanceContracts({
          client,
          contracts: selectPerformanceContracts(["fixture.frontier-pending-claim"]),
          profile,
        });

        expect(report.profile).toBe(profile);
        expect(report.passed).toBe(true);
        expect(report.contracts[0]?.resultRowCount.p50).toBe(25);
        expect(report.contracts[0]?.plan?.violations).toEqual([]);
      }
    } finally {
      client.close();
    }
  });

  it("retains deterministic mixed-load distributions and bounds as JSON metadata", async () => {
    const report = await runPerformanceContracts({
      client: NOOP_CLIENT,
      contracts: selectPerformanceContracts(["client.mixed-load"]),
      profile: "1x",
    });
    const metadata = report.contracts[0]?.metadata[0];

    expect(metadata).toMatchObject({
      maxPrimaryConcurrency: 4,
      primaryBound: 4,
      publicReadLatencyP95Ms: 5,
      publicReadQueueP95Ms: 0,
      scope: "per-client-simulator",
      telemetryBound: 3,
      violations: 0,
      writeBatchLatencyP95Ms: 21,
    });
  });

  it("runs correctness hooks for every measured iteration", async () => {
    const report = await runPerformanceContracts({
      client: NOOP_CLIENT,
      contracts: [
        {
          description: "correctness pin",
          async execute({ iteration }) {
            return { durationMs: 1, resultRowCount: iteration };
          },
          id: "route.correctness-pin",
          iterations: 3,
          validate(execution) {
            return execution.resultRowCount === 1 ? ["wrong result cardinality"] : [];
          },
          workClass: "route-db",
        },
      ],
      profile: "1x",
    });

    expect(report.contracts[0]?.validationFailures).toEqual([
      "iteration 2: wrong result cardinality",
    ]);
    expect(report.passed).toBe(false);
  });
});
