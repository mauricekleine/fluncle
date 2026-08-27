import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { LOCAL_DB_CONCURRENCY } from "../../src/lib/database-concurrency";

import {
  FINAL_INDEX_INVENTORY,
  buildIndexAudit,
  validateIndexInventory,
  type IndexInventoryDocument,
} from "./index-inventory";
import { indexEvidenceContracts } from "./index-evidence";
import { applyFixtureSchema, writeFixture } from "./fixture";
import { createCiFixtureCounts } from "./manifest";
import {
  type PerformanceClient,
  type PerformanceContract,
  runPerformanceContracts,
} from "./registry";

function cloneInventory(): IndexInventoryDocument {
  return JSON.parse(JSON.stringify(FINAL_INDEX_INVENTORY)) as IndexInventoryDocument;
}

describe("final index plan evidence", () => {
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

        expect(report.passed).toBe(true);
        expect(report.indexAudit?.passed).toBe(true);
        expect(report.indexAudit?.totals).toEqual({
          databaseScaleIndexes: 30,
          evidenceContracts: 67,
          indexes: 62,
          tracksIndexes: 32,
        });
        expect(report.indexAudit?.decisions.counts).toEqual({ add: 0, drop: 6, keep: 56 });
        expect(report.indexAudit?.productionInventory).toEqual({
          currentFinalSchemaBeforeContraction: { indexes: 178, tracksIndexes: 32 },
          finalSchemaAfterContraction: { indexes: 172, tracksIndexes: 30 },
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
