import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { LOCAL_DB_CONCURRENCY } from "../../src/lib/database-concurrency";
import { DUE_WORK_COLUMNS, DUE_WORK_COLUMN_NAMES } from "../../src/lib/server/due-work-columns";

import { DUE_WORK_PERFORMANCE_CLAIM_RESULT, selectPerformanceContracts } from "./contracts";
import { applyFixtureSchema, writeFixture } from "./fixture";
import { createCiFixtureCounts } from "./manifest";
import { type PerformanceClient, runPerformanceContracts } from "./registry";

const CLAIM_TOKEN = "synthetic-claim-token";
const CLAIM_OWNER = "synthetic-worker";
const WORK_KIND = "youtube-provenance-findings";

function dueWorkClaimContract() {
  const contract = selectPerformanceContracts(["fixture.due-work-claim"])[0];
  if (contract === undefined) {
    throw new Error("due-work claim contract is not registered");
  }
  return contract;
}

async function fixedClaimCount(client: PerformanceClient): Promise<number> {
  const result = await client.execute({
    args: [WORK_KIND, CLAIM_OWNER, CLAIM_TOKEN],
    sql: `select count(*) as n from due_work
      where work_kind = ? and state = 'leased' and claimed_by = ? and claim_token = ?`,
  });
  return Number((result.rows[0] as { n?: unknown } | undefined)?.n ?? -1);
}

describe("database performance contracts", () => {
  it("measures every generic comparison with only its final production statement", async () => {
    const comparisons = selectPerformanceContracts([]).filter(
      (contract) =>
        contract.terminalProof !== undefined &&
        contract.plan !== undefined &&
        contract.indexEvidence === undefined,
    );

    expect(comparisons).toHaveLength(11);
    for (const contract of comparisons) {
      let elapsedMs = 0;
      const executedSql: string[] = [];
      const execution = await contract.execute({
        client: {
          async execute(statement) {
            executedSql.push(typeof statement === "string" ? statement : statement.sql);
            elapsedMs += 17;
            return { rows: [] };
          },
        },
        iteration: 0,
        now: () => elapsedMs,
        profile: "1x",
      });

      expect(executedSql, contract.id).toHaveLength(1);
      expect(executedSql[0], contract.id).not.toMatch(/^EXPLAIN QUERY PLAN/i);
      expect(execution.durationMs, contract.id).toBe(17);
      expect(execution.metadata, contract.id).toEqual({
        finalStatementRequestCount: 1,
        timingScope: "single-final-statement",
      });
    }
  });

  it("shares the exact production due-work result columns", () => {
    expect(DUE_WORK_PERFORMANCE_CLAIM_RESULT.sql).toContain(
      `select ${DUE_WORK_COLUMNS} from due_work`,
    );
    expect(DUE_WORK_COLUMN_NAMES).toHaveLength(12);
  });

  it("finishes a due-work transaction before generic comparison proof and owns late failures", async () => {
    const comparison = selectPerformanceContracts(["sitemap.finding-pages"])[0];
    const dueWork = dueWorkClaimContract();
    if (!comparison?.terminalProof) {
      throw new Error("generic comparison contract has no terminal proof");
    }
    const terminalProof = comparison.terminalProof;
    const failingComparison = {
      ...comparison,
      terminalProof: {
        ...terminalProof,
        validate(execution: Parameters<NonNullable<typeof terminalProof.validate>>[0]) {
          return [
            ...(terminalProof.validate?.(execution) ?? []),
            "synthetic generic comparison violation",
          ];
        },
      },
    };

    const client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });
    const progress: { contractId?: string; phase: string }[] = [];
    try {
      await applyFixtureSchema(client);
      await writeFixture(client, "1x", { counts: createCiFixtureCounts("1x", 512) });
      const report = await runPerformanceContracts({
        client,
        contracts: [failingComparison, dueWork],
        onProgress: (event) => progress.push(event),
        profile: "1x",
      });
      const comparisonReport = report.contracts[0];
      const dueWorkReport = report.contracts[1];
      const dueWorkMeasurement = progress.findIndex(
        (event) =>
          event.contractId === "fixture.due-work-claim" && event.phase === "measured-iteration",
      );
      const comparisonProof = progress.findIndex(
        (event) => event.contractId === "sitemap.finding-pages" && event.phase === "terminal-proof",
      );

      expect(comparisonReport?.metadata[0]).toMatchObject({
        finalStatementRequestCount: 1,
        measuredRequestCount: 22,
        outputsEquivalent: true,
        terminalPlanRequestCount: 1,
        terminalProofRequestCount: 3,
        timingScope: "single-final-statement",
        totalRequestCount: 26,
      });
      expect(comparisonReport?.validationFailures).toEqual([
        "terminal proof: synthetic generic comparison violation",
      ]);
      expect(comparisonReport?.passed).toBe(false);
      expect(dueWorkReport?.validationFailures).toEqual([]);
      expect(dueWorkReport?.passed).toBe(true);
      expect(dueWorkMeasurement).toBeGreaterThanOrEqual(0);
      expect(comparisonProof).toBeGreaterThan(dueWorkMeasurement);
    } finally {
      client.close();
    }
  });

  it("clears stale fixed-token leases, claims exactly one page, and always releases it", async () => {
    const client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });
    try {
      await applyFixtureSchema(client);
      await writeFixture(client, "1x", { counts: createCiFixtureCounts("1x", 512) });
      await client.execute({
        args: [CLAIM_TOKEN, CLAIM_OWNER, WORK_KIND, 7],
        sql: `update due_work
          set state = 'leased', claim_token = ?, claimed_by = ?,
              claim_expires_at = '2099-01-01T00:01:00.000Z'
          where (work_kind, subject_type, subject_id) in (
            select work_kind, subject_type, subject_id from due_work
            where work_kind = ? and state = 'ready'
            order by sort_key, subject_id limit ?
          )`,
      });
      expect(await fixedClaimCount(client)).toBe(7);

      const contract = dueWorkClaimContract();
      const execution = await contract.execute({
        client,
        iteration: 0,
        now: performance.now.bind(performance),
        profile: "1x",
      });

      expect(execution.affectedRowCount).toBe(25);
      expect(execution.resultRowCount).toBe(25);
      expect(Object.keys(execution.rawResult?.rows[0] ?? {})).toEqual(DUE_WORK_COLUMN_NAMES);
      expect(contract.validate?.(execution)).toEqual([]);
      expect(contract.validate?.({ ...execution, affectedRowCount: 0 })).toContain(
        "due-work claim affected 0 rows, expected 25",
      );
      expect(await fixedClaimCount(client)).toBe(0);

      const failingClient: PerformanceClient = {
        async batch(statements, mode) {
          await client.batch(statements, mode);
          throw new Error("synthetic post-commit transport failure");
        },
        execute: client.execute.bind(client),
      };
      await expect(
        contract.execute({
          client: failingClient,
          iteration: 1,
          now: performance.now.bind(performance),
          profile: "1x",
        }),
      ).rejects.toThrow("synthetic post-commit transport failure");
      expect(await fixedClaimCount(client)).toBe(0);
    } finally {
      client.close();
    }
  });
});
