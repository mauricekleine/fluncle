import { createClient } from "@libsql/client";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCAL_DB_CONCURRENCY } from "../../src/lib/database-concurrency";

import {
  FINAL_INDEX_INVENTORY,
  buildIndexAudit,
  validateIndexInventory,
  type IndexInventoryDocument,
} from "./index-inventory";
import { INDEX_EVIDENCE_RUNTIME_LOCKED_INDEXES, indexEvidenceContracts } from "./index-evidence";
import { applyFixtureSchema, writeFixture } from "./fixture";
import { createCiFixtureCounts } from "./manifest";
import {
  type PerformanceClient,
  type PerformanceContract,
  runPerformanceContracts,
} from "./registry";

const REPOSITORY_ROOT = join(import.meta.dirname, "../../../..");

function cloneInventory(): IndexInventoryDocument {
  return JSON.parse(JSON.stringify(FINAL_INDEX_INVENTORY)) as IndexInventoryDocument;
}

describe("final index plan evidence", () => {
  it("uses normal planner choice except for SQL that deliberately locks a production index", () => {
    const runtimeLockedIndexes = new Set(INDEX_EVIDENCE_RUNTIME_LOCKED_INDEXES);
    const expectedPolicyFragments: Record<string, string> = {
      "artifact-change-checkpoints-primary-key":
        "sqlite_autoindex_perf_artifact_change_checkpoints_1",
      "artifact-changes-integer-primary-key": "INTEGER PRIMARY KEY.*rowid",
      "bounded-consumer-control-table": "perf_artifact_change_consumers",
      "operation-receipts-primary-key": "sqlite_autoindex_perf_operation_receipts_1",
    };
    const genericSimpleContracts = indexEvidenceContracts().filter((contract) => {
      const inventoryName = contract.indexEvidence?.inventoryEntry.name;

      return (
        contract.plan !== undefined &&
        inventoryName !== undefined &&
        inventoryName !== "tracks_release_date_idx" &&
        inventoryName !== "tracks_release_date_track_id_idx"
      );
    });

    expect(genericSimpleContracts.length).toBeGreaterThan(0);

    for (const contract of genericSimpleContracts) {
      const plan = contract.plan;
      const requiredIndex = contract.indexEvidence?.requiredIndexName;
      const inventoryName = contract.indexEvidence?.inventoryEntry.name;
      if (!plan || !requiredIndex || !inventoryName) {
        throw new Error(`generic index evidence contract is missing its plan: ${contract.id}`);
      }

      expect(plan.statement.sql.match(/\bINDEXED\s+BY\b/gi)?.length ?? 0).toBe(
        runtimeLockedIndexes.has(inventoryName) ? 1 : 0,
      );

      const expectedPolicyFragment =
        expectedPolicyFragments[requiredIndex] ?? `perf_${requiredIndex}`;
      expect(plan.policy.requiredDetails?.map((pattern) => pattern.source).join(" ")).toContain(
        expectedPolicyFragment,
      );
    }
  });

  it("resolves every final and per-contract consumer coordinate against the filesystem", async () => {
    const coordinates = FINAL_INDEX_INVENTORY.tracksIndexes
      .concat(FINAL_INDEX_INVENTORY.databaseScaleIndexes)
      .flatMap((entry) => [
        ...entry.finalConsumer.coordinates.map((coordinate) => ({
          coordinate,
          label: `${entry.name} final consumer`,
        })),
        ...entry.performanceContracts.flatMap((contract) =>
          contract.consumer.map((coordinate) => ({
            coordinate,
            label: `${entry.name} contract ${contract.id}`,
          })),
        ),
      ]);

    expect(coordinates.length).toBeGreaterThan(0);
    await Promise.all(
      coordinates.map(async ({ coordinate, label }) => {
        expect(coordinate.file, label).not.toBe("");
        expect(coordinate.marker, label).not.toBe("");
        const path = join(REPOSITORY_ROOT, coordinate.file);
        await expect(access(path), label).resolves.toBeUndefined();
        await expect(readFile(path, "utf8"), label).resolves.toContain(coordinate.marker);
      }),
    );
  });

  it("keeps Apple and Deezer catalogue worklists unforced with forced variants supplemental", async () => {
    const contract = indexEvidenceContracts().find(
      (candidate) => candidate.id === "index.tracks-capture-priority",
    );
    if (!contract?.plan) {
      throw new Error("capture-priority comparison contract has no plan");
    }

    const executedSql: string[] = [];
    const execution = await contract.execute({
      client: {
        async execute(statement) {
          const sql = typeof statement === "string" ? statement : statement.sql;
          executedSql.push(sql);

          if (/^EXPLAIN QUERY PLAN/i.test(sql)) {
            return {
              rows: [{ detail: "SEARCH perf_tracks USING INDEX perf_tracks_vendor_worklist_idx" }],
            };
          }
          if (/sqlite_master/i.test(sql)) {
            return { rows: [] };
          }

          return { rows: [{ isrc: "synthetic-isrc", track_id: "synthetic-track-000000000" }] };
        },
      },
      iteration: 0,
      now: () => 0,
      profile: "1x",
    });
    const dataSql = executedSql.filter(
      (sql) => !/^EXPLAIN QUERY PLAN/i.test(sql) && !/sqlite_master/i.test(sql),
    );
    const [apple, deezer, forcedApple, forcedDeezer] = dataSql;
    if (!apple || !deezer || !forcedApple || !forcedDeezer) {
      throw new Error("capture-priority comparison did not execute both vendor variants");
    }

    expect(dataSql).toHaveLength(4);
    expect(apple).not.toMatch(/\bINDEXED\s+BY\b/i);
    expect(deezer).not.toMatch(/\bINDEXED\s+BY\b/i);
    expect(forcedApple).toMatch(/\bINDEXED\s+BY\s+perf_tracks_vendor_worklist_idx\b/i);
    expect(forcedDeezer).toMatch(/\bINDEXED\s+BY\s+perf_tracks_vendor_worklist_idx\b/i);
    for (const pattern of [
      /track_id/i,
      /isrc/i,
      /album_id/i,
      /backfill_apple_music_attempted_at/i,
      /backfill_apple_music_failures/i,
      /apple_music_url/i,
      /backfill_apple_music_done_at/i,
      /capture_priority desc/i,
      /track_id desc/i,
    ]) {
      expect(apple).toMatch(pattern);
    }
    for (const pattern of [
      /track_id/i,
      /isrc/i,
      /duration_ms/i,
      /deezer_track_id/i,
      /backfill_deezer_attempted_at/i,
      /backfill_deezer_failures/i,
      /capture_priority desc/i,
      /track_id desc/i,
    ]) {
      expect(deezer).toMatch(pattern);
    }
    expect(execution.metadata?.outputsEquivalent).toBe(true);
    expect(execution.metadata?.productionPlanViolations).toBe(0);
  });

  it("keeps forced release-date variants supplemental to the unforced production plan", async () => {
    const contract = indexEvidenceContracts().find(
      (candidate) => candidate.id === "index.tracks-release-date-drop-default-hub",
    );
    if (!contract?.plan) {
      throw new Error("default hub release-date comparison contract has no plan");
    }

    const executedSql: string[] = [];
    const execution = await contract.execute({
      client: {
        async execute(statement) {
          const sql = typeof statement === "string" ? statement : statement.sql;
          executedSql.push(sql);

          if (/^EXPLAIN QUERY PLAN/i.test(sql) || /sqlite_master/i.test(sql)) {
            return { rows: [] };
          }

          return { rows: [{ rd: "2026", track_id: "synthetic-track-000000000" }] };
        },
      },
      iteration: 0,
      now: () => 0,
      profile: "1x",
    });
    const dataSql = executedSql.filter(
      (sql) => !/^EXPLAIN QUERY PLAN/i.test(sql) && !/sqlite_master/i.test(sql),
    );

    expect(contract.plan.statement.sql).not.toMatch(/\bINDEXED\s+BY\b/i);
    expect(execution.metadata?.outputsEquivalent).toBe(true);
    expect(dataSql).toHaveLength(4);
    expect(dataSql.slice(0, 2).every((sql) => !/\bINDEXED\s+BY\b/i.test(sql))).toBe(true);
    expect(
      dataSql
        .slice(2)
        .every((sql) => /\bINDEXED\s+BY\s+perf_tracks_release_date_track_id_idx\b/i.test(sql)),
    ).toBe(true);
  });

  it("keeps the exact default-hub release lock in the production plan", () => {
    const contract = indexEvidenceContracts().find(
      (candidate) => candidate.id === "index.tracks-release-date-track-id",
    );
    if (!contract?.plan) {
      throw new Error("default-hub release-date lock contract has no plan");
    }

    expect(INDEX_EVIDENCE_RUNTIME_LOCKED_INDEXES).toContain("tracks_release_date_track_id_idx");
    expect(contract.plan.statement.sql).toMatch(
      /\bINDEXED\s+BY\s+perf_tracks_release_date_track_id_idx\b/i,
    );
  });

  it("rejects missing consumers, plan contracts, and required profile declarations", () => {
    const missingConsumer = cloneInventory();
    const firstConsumer = missingConsumer.tracksIndexes[0];
    if (!firstConsumer) {
      throw new Error("fixture inventory has no track entries");
    }
    firstConsumer.finalConsumer.query = "";
    expect(validateIndexInventory(missingConsumer)).toContain(
      "tracks_album_id_idx is missing its final consumer or query",
    );

    const missingPlan = cloneInventory();
    const firstPlan = missingPlan.tracksIndexes[0];
    if (!firstPlan) {
      throw new Error("fixture inventory has no track entries");
    }
    firstPlan.performanceContracts = [];
    expect(validateIndexInventory(missingPlan)).toContain(
      "tracks_album_id_idx has no plan-evidence contract",
    );

    const missingProfile = cloneInventory();
    const firstProfile = missingProfile.tracksIndexes[0];
    if (!firstProfile) {
      throw new Error("fixture inventory has no track entries");
    }
    const firstProfileContract = firstProfile.performanceContracts[0];
    if (!firstProfileContract) {
      throw new Error("fixture inventory entry has no contract");
    }
    firstProfileContract.requiredProfiles = ["1x", "2x"];
    expect(validateIndexInventory(missingProfile)).toContain(
      "tracks_album_id_idx contract index.tracks-album-id is missing a required profile",
    );
  });

  it("fails the audit when a declared evidence contract is not executed", () => {
    const contract = indexEvidenceContracts()[0];
    if (!contract) {
      throw new Error("index evidence registry is empty");
    }

    const audit = buildIndexAudit({
      contracts: [contract],
      profile: "1x",
      reports: [],
    });

    expect(audit).not.toBeNull();
    expect(audit?.missingConsumers).toEqual([]);
    expect(audit?.missingPlanEvidence).toHaveLength(67);
    expect(audit?.missingProfileEvidence).toEqual([]);
    expect(audit?.passed).toBe(false);
  });

  it("runs all declared evidence at every local profile and omits the dropped singleton", async () => {
    const contracts = indexEvidenceContracts();

    expect(contracts).toHaveLength(67);
    expect(
      contracts.every((contract) => contract.indexEvidence?.inventoryEntry.finalConsumer.query),
    ).toBe(true);

    for (const profile of ["1x", "2x", "4x"] as const) {
      const client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });

      try {
        await applyFixtureSchema(client);
        await writeFixture(client, profile, { counts: createCiFixtureCounts(profile, 512) });
        const report = await runPerformanceContracts({ client, contracts, profile });

        expect(
          report.passed,
          JSON.stringify(
            report.contracts
              .filter((contract) => !contract.passed)
              .map((contract) => ({
                budgetFailures: contract.budget.failures,
                contractId: contract.contractId,
                plan: contract.plan,
                validationFailures: contract.validationFailures,
              })),
          ),
        ).toBe(true);
        expect(report.indexAudit?.passed).toBe(true);
        expect(report.indexAudit?.totals).toEqual({
          databaseScaleIndexes: 30,
          evidenceContracts: 67,
          indexes: 62,
          tracksIndexes: 32,
        });
        expect(report.indexAudit?.decisions.counts).toEqual({ add: 0, drop: 7, keep: 55 });
        expect(report.indexAudit?.productionInventory).toEqual({
          currentFinalSchemaBeforeContraction: { indexes: 178, tracksIndexes: 32 },
          finalSchemaAfterContraction: { indexes: 171, tracksIndexes: 29 },
        });
        expect(report.indexAudit?.missingConsumers).toEqual([]);
        expect(report.indexAudit?.missingPlanEvidence).toEqual([]);
        expect(report.indexAudit?.missingProfileEvidence).toEqual([]);
        expect(report.indexAudit?.profileEvidence[profile]).toEqual({
          declaredContracts: 67,
          observedContracts: 67,
        });

        const auditEntries = report.indexAudit?.entries ?? [];
        const evidence = auditEntries.flatMap((entry) => entry.contracts);
        expect(auditEntries).toHaveLength(62);
        expect(evidence).toHaveLength(67);
        expect(
          evidence.every(
            (contractEvidence) =>
              contractEvidence.passed &&
              contractEvidence.plan !== null &&
              contractEvidence.plan.violations.length === 0 &&
              Number(contractEvidence.metadata?.minimumResultRows) <=
                contractEvidence.resultRowCount?.p50 &&
              contractEvidence.requiredProfiles.join(",") === "1x,2x,4x",
          ),
        ).toBe(true);

        const droppedIndex = auditEntries.find((entry) => entry.name === "tracks_release_date_idx");
        expect(droppedIndex?.decision).toBe("drop");
        expect(droppedIndex?.contracts).toHaveLength(6);
        expect(droppedIndex?.contracts.map((contract) => contract.contractId)).toEqual([
          "index.tracks-release-date-drop-fresh",
          "index.tracks-release-date-drop-public-findings",
          "index.tracks-release-date-drop-public-records",
          "index.tracks-release-date-drop-year",
          "index.tracks-release-date-drop-default-hub",
          "index.tracks-release-date-drop-search",
        ]);
        expect(
          droppedIndex?.contracts.every(
            (contract) =>
              contract.metadata?.outputsEquivalent === true &&
              contract.metadata.requiredIndex === "tracks_release_date_track_id_idx" &&
              contract.metadata.productionPlanUsesDroppedIndex === false &&
              contract.metadata.productionPlanViolations === 0,
          ),
        ).toBe(true);
        const capturePriorityDrop = auditEntries.find(
          (entry) => entry.name === "tracks_capture_priority_idx",
        );
        expect(capturePriorityDrop?.decision).toBe("drop");
        expect(capturePriorityDrop?.contracts).toHaveLength(1);
        expect(capturePriorityDrop?.contracts[0]?.metadata).toMatchObject({
          outputsEquivalent: true,
          productionPlanUsesDroppedIndex: false,
          productionPlanViolations: 0,
          requiredIndex: "tracks_vendor_worklist_idx",
        });
        const freshEvidence = droppedIndex?.contracts.find(
          (contract) => contract.contractId === "index.tracks-release-date-drop-fresh",
        );
        const freshPlans = JSON.parse(String(freshEvidence?.metadata?.productionPlanDetails)) as
          | string[][]
          | undefined;
        expect(freshPlans).toHaveLength(4);
        expect(
          freshPlans?.every((details) => details.some((detail) => /USING INDEX/.test(detail))),
        ).toBe(true);
        const publicFindingsEvidence = droppedIndex?.contracts.find(
          (contract) => contract.contractId === "index.tracks-release-date-drop-public-findings",
        );
        const publicFindingsPlans = JSON.parse(
          String(publicFindingsEvidence?.metadata?.productionPlanDetails),
        ) as string[][] | undefined;
        expect(publicFindingsPlans?.[0]).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/perf_findings/i),
            expect.stringMatching(/perf_tracks/i),
            expect.stringMatching(/perf_track_artists/i),
            expect.stringMatching(/perf_artists/i),
          ]),
        );
        const publicRecordsEvidence = droppedIndex?.contracts.find(
          (contract) => contract.contractId === "index.tracks-release-date-drop-public-records",
        );
        const publicRecordsPlans = JSON.parse(
          String(publicRecordsEvidence?.metadata?.productionPlanDetails),
        ) as string[][] | undefined;
        expect(publicRecordsPlans?.[0]).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/perf_tracks_release_date_track_id_idx/i),
            expect.stringMatching(/perf_albums/i),
          ]),
        );
        const indexes = await client.execute(
          "select name from sqlite_master where type = 'index' and name = 'perf_tracks_release_date_idx'",
        );
        expect(indexes.rows).toEqual([]);
        const allDroppedIndexes = [
          "perf_artifact_change_checkpoints_running_idx",
          "perf_artifact_change_consumers_compaction_idx",
          "perf_artifact_changes_created_seq_idx",
          "perf_operation_receipts_operation_audit_idx",
          "perf_tracks_capture_priority_idx",
          "perf_tracks_nearest_finding_score_idx",
          "perf_tracks_release_date_idx",
        ];
        const droppedRows = await client.execute({
          args: allDroppedIndexes,
          sql: `select name from sqlite_master
            where type = 'index' and name in (${allDroppedIndexes.map(() => "?").join(", ")})`,
        });
        expect(droppedRows.rows).toEqual([]);
      } finally {
        client.close();
      }
    }
  });

  it("fails a malicious index contract whose plan scans and sorts a growing table", async () => {
    const original = indexEvidenceContracts()[0];
    if (!original?.plan) {
      throw new Error("index evidence contract has no plan");
    }

    const client: PerformanceClient = {
      async execute(statement) {
        const sql = typeof statement === "string" ? statement : statement.sql;

        if (sql.startsWith("EXPLAIN QUERY PLAN")) {
          return {
            rows: [{ detail: "SCAN perf_tracks" }, { detail: "USE TEMP B-TREE FOR ORDER BY" }],
          };
        }

        return { rows: [{ album_id: "synthetic-album-000000000" }] };
      },
    };
    const malicious: PerformanceContract = {
      ...original,
      plan: {
        policy: original.plan.policy,
        statement: {
          args: [],
          sql: "select album_id from perf_tracks order by title",
        },
      },
    };

    const report = await runPerformanceContracts({
      client,
      contracts: [malicious],
      profile: "1x",
    });

    expect(report.passed).toBe(false);
    expect(report.contracts[0]?.plan?.fullScans).toEqual([
      { detail: "SCAN perf_tracks", table: "perf_tracks" },
    ]);
    expect(report.contracts[0]?.plan?.tempSorts).toEqual(["USE TEMP B-TREE FOR ORDER BY"]);
    expect(report.contracts[0]?.plan?.violations).toHaveLength(3);
    expect(report.indexAudit?.passed).toBe(false);
  });
});
