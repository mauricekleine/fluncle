import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { LOCAL_DB_CONCURRENCY } from "../../src/lib/database-concurrency";

import { performanceRegistry, selectPerformanceContracts } from "./contracts";
import { CONTRACT_D_CONTRACT_IDS } from "./contract-d";
import { applyFixtureSchema, writeFixture } from "./fixture";
import { createCiFixtureCounts } from "./manifest";
import { ISOLATED_LOCAL_LIBSQL_RESOURCE_SOURCE } from "./local-sidecar";
import {
  PerformanceRegistry,
  executePerformanceBatch,
  type PerformanceClient,
  type PerformanceExecutionProgress,
  runPerformanceContracts,
  sqlContract,
} from "./registry";

const NOOP_CLIENT: PerformanceClient = {
  async execute() {
    return { rows: [] };
  },
};

function transportTimeout(secretDetail = "sensitive transport detail"): Error {
  const timeout = new Error(secretDetail);
  timeout.name = "TimeoutError";
  return timeout;
}

describe("performance registry", () => {
  it("requires one explicit write batch for transactional contract transport", async () => {
    const calls: { mode: string; statementCount: number }[] = [];
    const client: PerformanceClient = {
      async batch(statements, mode) {
        calls.push({ mode, statementCount: statements.length });
        return statements.map(() => ({ rows: [] }));
      },
      async execute() {
        return { rows: [] };
      },
    };

    await expect(
      executePerformanceBatch(client, [
        { args: [], sql: "select 1" },
        { args: [], sql: "select 2" },
      ]),
    ).resolves.toHaveLength(2);
    expect(calls).toEqual([{ mode: "write", statementCount: 2 }]);
    await expect(executePerformanceBatch(NOOP_CLIENT, [])).rejects.toThrow(
      "performance contract requires transactional batch support",
    );
  });

  it("times due-work and crawl claims as their single production transaction request", async () => {
    const dueWorkBatches: { mode: string; statementCount: number }[] = [];
    let dueWorkClock = 0;
    const dueWorkRows = Array.from({ length: 25 }, (_value, index) => ({
      claim_expires_at: "2099-01-01T00:01:00.000Z",
      claim_token: "synthetic-claim-token",
      claimed_by: "synthetic-worker",
      generation: "live",
      next_due_at: "2099-01-01T00:00:00.000Z",
      sort_key: `${index}`,
      source_version: `${index}`,
      state: "leased",
      subject_id: `${index}`,
      subject_type: "track",
      updated_at: "2099-01-01T00:00:00.000Z",
      work_kind: "youtube-provenance-findings",
    }));
    const dueWorkClient: PerformanceClient = {
      async batch(statements, mode) {
        dueWorkBatches.push({ mode, statementCount: statements.length });
        dueWorkClock += 17;
        return [
          { rows: [], rowsAffected: 0 },
          { rows: [], rowsAffected: 0 },
          { rows: [], rowsAffected: 25 },
          { rows: dueWorkRows },
          { rows: [{ subject_id: "remaining" }] },
        ];
      },
      async execute() {
        dueWorkClock += 100;
        return { rows: [{ n: 100 }], rowsAffected: 25 };
      },
    };
    const dueWorkContract = selectPerformanceContracts(["fixture.due-work-claim"])[0];
    if (dueWorkContract === undefined) {
      throw new Error("due-work claim contract is not registered");
    }
    const dueWork = await dueWorkContract.execute({
      client: dueWorkClient,
      iteration: 0,
      now: () => dueWorkClock,
      profile: "1x",
    });

    expect(dueWork.durationMs).toBe(17);
    expect(dueWork.batchCount).toBe(1);
    expect(dueWork.metadata).toEqual({
      batchResultCount: 5,
      claimResultColumnCount: 12,
      claimResultRowsHaveProductionShape: true,
      measuredRequestCount: 1,
      measuredStatementCount: 5,
      readySentinelRows: 1,
      transactionalBatch: true,
    });
    expect(dueWork.convergence?.converged).toBe(true);
    expect(dueWorkBatches).toEqual([{ mode: "write", statementCount: 5 }]);
    expect(dueWorkContract.validate?.(dueWork)).toEqual([]);

    const crawlBatches: { mode: string; statementCount: number }[] = [];
    let crawlClock = 0;
    const crawlRows = Array.from({ length: 500 }, (_value, index) => ({
      claim_position: index,
      node_id: `node-${index}`,
      node_kind: index < 250 ? "release" : "artist",
    }));
    const crawlClient: PerformanceClient = {
      async batch(statements, mode) {
        crawlBatches.push({ mode, statementCount: statements.length });
        crawlClock += 23;
        return [
          { rows: [], rowsAffected: 500 },
          { rows: crawlRows },
          { rows: [{ node_id: "remaining" }] },
        ];
      },
      async execute(statement) {
        crawlClock += 100;
        const sql = typeof statement === "string" ? statement : statement.sql;
        return {
          rows: [{ n: sql.includes("perf_crawl_projection_repairs") ? 0 : 1_000 }],
          rowsAffected: 500,
        };
      },
    };
    const crawlContract = selectPerformanceContracts(["projection.crawl-two-lane-claim"])[0];
    if (crawlContract === undefined) {
      throw new Error("crawl claim contract is not registered");
    }
    const crawl = await crawlContract.execute({
      client: crawlClient,
      iteration: 0,
      now: () => crawlClock,
      profile: "1x",
    });

    expect(crawl.durationMs).toBe(23);
    expect(crawl.batchCount).toBe(1);
    expect(crawl.metadata).toMatchObject({
      batchResultCount: 3,
      measuredRequestCount: 1,
      measuredStatementCount: 3,
      transactionalBatch: true,
    });
    expect(crawl.convergence?.converged).toBe(true);
    expect(crawlBatches).toEqual([{ mode: "write", statementCount: 3 }]);
    expect(crawlContract.validate?.(crawl)).toEqual([]);
    expect(JSON.stringify([dueWork.metadata, crawl.metadata])).not.toMatch(
      /\b(?:select|update|insert|delete)\b/i,
    );
  });

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

  it("reports an unavailable resource sample when a contract-only caller omits one", async () => {
    const report = await runPerformanceContracts({
      client: NOOP_CLIENT,
      contracts: [],
      profile: "1x",
    });

    expect(report.resources).toMatchObject({
      availability: "unavailable",
      peak: null,
      sampleSource: null,
      unavailableReason: expect.stringContaining("not supplied"),
    });
    expect(report.criteria.resources).toMatchObject({ addressed: false, passed: null });
  });

  it("rejects invalid supplied resource values instead of coercing them to zero", async () => {
    await expect(
      runPerformanceContracts({
        client: NOOP_CLIENT,
        contracts: [],
        profile: "1x",
        resource: {
          sample: () => ({ heapUsedBytes: -1, rssBytes: 1 }),
        },
      }),
    ).rejects.toThrow("resource sampling returned an invalid heapUsedBytes value");
  });

  it("retains an explicit process-boundary source with the default sampler", async () => {
    const report = await runPerformanceContracts({
      client: NOOP_CLIENT,
      contracts: [],
      profile: "1x",
      resource: { sampleSource: ISOLATED_LOCAL_LIBSQL_RESOURCE_SOURCE },
    });

    expect(report.resources).toMatchObject({
      availability: "measured",
      sampleSource: ISOLATED_LOCAL_LIBSQL_RESOURCE_SOURCE,
    });
  });

  it("adds safe contract and phase context to index-plan timeouts", async () => {
    const progress: PerformanceExecutionProgress[] = [];
    const timeout = new Error("outer transport detail", {
      cause: transportTimeout("secret SQL and topology"),
    });
    const execution = runPerformanceContracts({
      client: {
        async execute() {
          throw timeout;
        },
      },
      contracts: [
        {
          description: "index timeout pin",
          async execute() {
            return { resultRowCount: 0 };
          },
          id: "route.index-timeout-pin",
          iterations: 1,
          plan: {
            policy: { growingTables: [] },
            statement: { args: [], sql: "select secret from private_topology" },
          },
          workClass: "route-db",
        },
      ],
      onProgress: (event) => progress.push(event),
      profile: "1x",
    });

    await expect(execution).rejects.toMatchObject({
      message:
        "[db-performance] phase=index-plan contract=route.index-timeout-pin request timed out",
      name: "TimeoutError",
    });
    expect(progress).toEqual([
      {
        contractId: "route.index-timeout-pin",
        iteration: 1,
        iterations: 1,
        phase: "measured-iteration",
      },
      { contractId: "route.index-timeout-pin", phase: "index-plan" },
    ]);
  });

  it("adds safe contract and iteration context to warmup timeouts", async () => {
    const progress: PerformanceExecutionProgress[] = [];
    const execution = runPerformanceContracts({
      client: NOOP_CLIENT,
      contracts: [
        {
          description: "warmup timeout pin",
          async execute() {
            throw transportTimeout();
          },
          id: "route.warmup-timeout-pin",
          iterations: 2,
          warmupIterations: 3,
          workClass: "route-db",
        },
      ],
      onProgress: (event) => progress.push(event),
      profile: "1x",
    });

    await expect(execution).rejects.toMatchObject({
      message:
        "[db-performance] phase=warmup contract=route.warmup-timeout-pin iteration=1/3 request timed out",
      name: "TimeoutError",
    });
    expect(progress).toEqual([
      {
        contractId: "route.warmup-timeout-pin",
        iteration: 1,
        iterations: 3,
        phase: "warmup",
      },
    ]);
  });

  it("adds safe contract and iteration context to measured timeouts", async () => {
    const progress: PerformanceExecutionProgress[] = [];
    const execution = runPerformanceContracts({
      client: NOOP_CLIENT,
      contracts: [
        {
          description: "measured timeout pin",
          async execute() {
            throw transportTimeout();
          },
          id: "route.measured-timeout-pin",
          iterations: 4,
          workClass: "route-db",
        },
      ],
      onProgress: (event) => progress.push(event),
      profile: "1x",
    });

    await expect(execution).rejects.toMatchObject({
      message:
        "[db-performance] phase=measured-iteration contract=route.measured-timeout-pin iteration=1/4 request timed out",
      name: "TimeoutError",
    });
    expect(progress).toEqual([
      {
        contractId: "route.measured-timeout-pin",
        iteration: 1,
        iterations: 4,
        phase: "measured-iteration",
      },
    ]);
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

  it("finishes production-shaped write batches before terminal plan audits", async () => {
    const client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });
    try {
      await client.execute(
        "create table batch_probe (id integer primary key, value text not null)",
      );
      await client.execute("insert into batch_probe (id, value) values (1, 'before')");
      const report = await runPerformanceContracts({
        client,
        contracts: [
          {
            description: "late failing plan pin",
            async execute() {
              return { resultRowCount: 0 };
            },
            id: "route.late-plan-pin",
            iterations: 1,
            plan: {
              policy: { forbidTempSort: true, growingTables: ["batch_probe"] },
              statement: {
                args: [],
                sql: "select value from batch_probe order by value",
              },
            },
            workClass: "route-db",
          },
          {
            description: "production-shaped batch pin",
            async execute(context) {
              const startedAt = context.now();
              const results = await executePerformanceBatch(context.client, [
                { args: ["after", 1], sql: "update batch_probe set value = ? where id = ?" },
                { args: [1], sql: "select value from batch_probe where id = ?" },
              ]);
              const result = results[1] ?? { rows: [] };
              return {
                batchCount: 1,
                durationMs: Math.max(0, context.now() - startedAt),
                resultRowCount: result.rows.length,
              };
            },
            id: "queue.production-batch-pin",
            iterations: 1,
            workClass: "queue",
          },
        ],
        profile: "1x",
      });

      expect(report.contracts[0]?.plan?.violations.length).toBeGreaterThan(0);
      expect(report.contracts[0]?.passed).toBe(false);
      expect(report.contracts[1]?.passed).toBe(true);
      expect(report.passed).toBe(false);
      expect((await client.execute("select value from batch_probe where id = 1")).rows[0]).toEqual({
        value: "after",
      });
    } finally {
      client.close();
    }
  });

  it("attaches a late structural proof violation only to its owning report", async () => {
    const report = await runPerformanceContracts({
      client: NOOP_CLIENT,
      contracts: [
        {
          description: "terminal structural failure pin",
          async execute() {
            return { durationMs: 1, resultRowCount: 1 };
          },
          id: "projection.terminal-structural-failure-pin",
          iterations: 1,
          terminalProof: {
            async execute() {
              return { metadata: { structuralOwner: "first" }, resultRowCount: 1 };
            },
            validate() {
              return ["structural proof failed"];
            },
          },
          workClass: "projection",
        },
        {
          description: "terminal structural neighbour pin",
          async execute() {
            return { durationMs: 1, resultRowCount: 1 };
          },
          id: "projection.terminal-structural-neighbour-pin",
          iterations: 1,
          workClass: "projection",
        },
      ],
      profile: "1x",
    });

    expect(report.contracts[0]?.validationFailures).toEqual([
      "terminal proof: structural proof failed",
    ]);
    expect(report.contracts[0]?.metadata).toEqual([{ structuralOwner: "first" }]);
    expect(report.contracts[0]?.passed).toBe(false);
    expect(report.contracts[1]?.validationFailures).toEqual([]);
    expect(report.contracts[1]?.metadata).toEqual([]);
    expect(report.contracts[1]?.passed).toBe(true);
    expect(report.passed).toBe(false);
  });

  it("proves empty, bounded-read, and bounded-claim due-work plans at 1x, 2x, and 4x", async () => {
    for (const profile of ["1x", "2x", "4x"] as const) {
      const client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });
      try {
        await applyFixtureSchema(client);
        const counts = createCiFixtureCounts(profile, 512);
        await writeFixture(client, profile, { counts });
        const report = await runPerformanceContracts({
          client,
          contracts: selectPerformanceContracts([
            "fixture.due-work-claim",
            "fixture.due-work-ready",
            "fixture.due-work-ready-empty",
          ]),
          profile,
        });

        expect(report.profile).toBe(profile);
        expect(report.passed).toBe(true);
        expect(
          report.contracts
            .map((contract) => contract.resultRowCount.p50)
            .sort((left, right) => left - right),
        ).toEqual([0, 25, 25]);
        expect(report.contracts.every((contract) => contract.plan?.violations.length === 0)).toBe(
          true,
        );
      } finally {
        client.close();
      }
    }
  });

  it("runs every Contract D observation at every scale with bounded rows and clean plans", async () => {
    const expectedRows: Record<(typeof CONTRACT_D_CONTRACT_IDS)[number], number> = {
      "projection.crawl-ready-sentinel": 1,
      "projection.crawl-two-lane-claim": 500,
      "projection.crawl-two-lane-read": 500,
      "projection.default-anchor-keyset": 48,
      "projection.default-anchor-validity": 1,
      "projection.public-keys": 5,
      "projection.public-readiness": 1,
      "projection.public-release-years": 5,
      "projection.public-total": 1,
      "projection.qualified-artists": 6,
    };

    const contracts = CONTRACT_D_CONTRACT_IDS.map((id) => performanceRegistry.get(id));

    for (const profile of ["1x", "2x", "4x"] as const) {
      const client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });
      try {
        await applyFixtureSchema(client);
        const fixtureCounts = createCiFixtureCounts(profile, 512);
        await writeFixture(client, profile, { counts: fixtureCounts });
        const report = await runPerformanceContracts({
          client,
          contracts,
          fixtureCounts,
          profile,
        });

        expect(report.profile).toBe(profile);
        expect(report.passed).toBe(true);
        expect(report.contracts).toHaveLength(CONTRACT_D_CONTRACT_IDS.length);

        for (const contract of report.contracts) {
          const expected =
            expectedRows[contract.contractId as (typeof CONTRACT_D_CONTRACT_IDS)[number]];

          expect(contract.workClass).toBe("projection");
          expect(contract.budget.required).toBe(true);
          expect(contract.budget.failures).toEqual([]);
          expect(contract.durationMs.p95).toBeLessThanOrEqual(250);
          expect(contract.plan).not.toBeNull();
          expect(contract.plan?.violations).toEqual([]);
          expect(contract.plan?.tempSorts).toEqual([]);
          expect(contract.resultRowCount).toEqual({
            max: expected,
            p50: expected,
            p95: expected,
            p99: expected,
          });
          expect(contract.plan?.fullScans.some((scan) => scan.table.startsWith("perf_"))).toBe(
            false,
          );
        }
        const keyset = report.contracts.find(
          (contract) => contract.contractId === "projection.default-anchor-keyset",
        );
        expect(Number(keyset?.metadata[0]?.nullFillRows ?? 0)).toBeGreaterThan(0);
      } finally {
        client.close();
      }
    }
  });

  it("records Goal B equivalence while rejecting the original artist scan and sitemap sort", async () => {
    const client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });
    const contractIds = [
      "artist-link.identity-resolution",
      "artist-link.name-resolution",
      "sitemap.albums-lastmod",
      "sitemap.artists-lastmod",
      "sitemap.finding-pages",
      "sitemap.finding-stats",
      "sitemap.labels-lastmod",
      "track-resolver.all-matches",
      "track-resolver.bulk",
      "track-resolver.optional-finding",
      "track-resolver.required-finding",
    ];

    try {
      await applyFixtureSchema(client);
      await writeFixture(client, "1x", { counts: createCiFixtureCounts("1x", 256) });
      const report = await runPerformanceContracts({
        client,
        contracts: selectPerformanceContracts(contractIds),
        profile: "2x",
      });

      expect(report.passed).toBe(true);
      expect(report.contracts.map((contract) => contract.contractId)).toEqual(contractIds);

      for (const contract of report.contracts) {
        expect(contract.metadata[0]?.outputsEquivalent).toBe(true);
        expect(contract.metadata[0]?.beforeResultRowCount).toBe(contract.resultRowCount.p50);
        expect(contract.plan?.violations).toEqual([]);
        expect(contract.plan?.tempSorts).toEqual([]);
      }

      const artist = report.contracts.find(
        (contract) => contract.contractId === "artist-link.identity-resolution",
      );
      expect(artist?.metadata[0]?.beforeFullScanCount).toBeGreaterThan(0);
      expect(artist?.metadata[0]?.beforePlanViolationCount).toBeGreaterThan(0);
      expect(artist?.plan?.details.some((detail) => /perf_artists_mbid_idx/i.test(detail))).toBe(
        true,
      );
      expect(
        artist?.plan?.details.some((detail) => /perf_artists_name_nocase_idx/i.test(detail)),
      ).toBe(true);

      const findingPages = report.contracts.find(
        (contract) => contract.contractId === "sitemap.finding-pages",
      );
      expect(findingPages?.metadata[0]?.beforePlanDetails).toMatch(/USE TEMP B-TREE/i);
      expect(findingPages?.plan?.details[0]).toMatch(/perf_findings/i);

      for (const contractId of [
        "track-resolver.all-matches",
        "track-resolver.bulk",
        "track-resolver.optional-finding",
        "track-resolver.required-finding",
      ]) {
        const resolver = report.contracts.find((contract) => contract.contractId === contractId);

        expect(resolver?.metadata[0]?.beforePlanViolationCount).toBeGreaterThan(0);
        expect(resolver?.plan?.details).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/sqlite_autoindex_perf_tracks_1/i),
            expect.stringMatching(/perf_findings_log_id_unique/i),
          ]),
        );
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
