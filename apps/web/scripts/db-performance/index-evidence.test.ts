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
import { selectPerformanceContracts } from "./contracts";
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
  it("runs the three reviewed consumers unforced, in their application shapes", () => {
    const contracts = new Map(indexEvidenceContracts().map((contract) => [contract.id, contract]));
    const artifact = contracts.get("index.artifact-changes-stream-seq");
    const bpm = contracts.get("index.tracks-bpm");
    const catalogue = contracts.get("index.tracks-is-catalogue");

    if (!artifact?.plan || !bpm?.plan || !catalogue?.plan) {
      throw new Error("reviewed index consumer plan is missing");
    }

    for (const plan of [artifact.plan, bpm.plan, catalogue.plan]) {
      expect(plan.statement.sql).not.toMatch(/\bINDEXED\s+BY\b/i);
    }
    expect(artifact.plan.statement.sql).toMatch(/select created_at, format_version, operation/i);
    expect(artifact.plan.statement.sql).toMatch(/where seq > \?/i);
    expect(artifact.plan.statement.sql).toMatch(/order by seq/i);
    expect(bpm.plan.statement.sql).toMatch(/from perf_tracks tracks left join perf_findings/i);
    expect(bpm.plan.statement.sql).toMatch(/tracks\.bpm >= \? and tracks\.bpm <= \?/i);
    expect(bpm.plan.statement.sql).toMatch(/case when findings\.track_id is null/i);
    expect(bpm.plan.statement.sql).toMatch(/limit \?/i);
    expect(catalogue.plan.statement.sql).toBe(
      "select count(*) as total from perf_tracks where perf_tracks.is_catalogue = 1",
    );
  });

  it("runs the eight reviewed crawl consumers locked and unforced in the same application shape", async () => {
    const reviewed = [
      "index.crawl-due-work-label-slug-node-id",
      "index.crawl-due-work-parent-id-node-id",
      "index.crawl-due-work-ready",
      "index.crawl-due-work-release-ready",
      "index.crawl-due-work-repair",
      "index.crawl-due-work-scheduled",
      "index.crawl-projection-repairs-order",
      "index.crawl-due-work-claim-position",
    ];
    const contracts = new Map(indexEvidenceContracts().map((contract) => [contract.id, contract]));

    for (const contractId of reviewed) {
      const contract = contracts.get(contractId);
      if (!contract?.plan || !contract.terminalProof || !contract.indexEvidence) {
        throw new Error(`reviewed crawl index consumer plan is missing: ${contractId}`);
      }
      const executedSql: string[] = [];
      await contract.terminalProof.execute({
        client: {
          async execute(candidate) {
            const sql = typeof candidate === "string" ? candidate : candidate.sql;
            executedSql.push(sql);
            return /^EXPLAIN QUERY PLAN/i.test(sql)
              ? { rows: [{ detail: "SEARCH synthetic fixture" }] }
              : { rows: [{ node_id: "synthetic-frontier-000000001" }] };
          },
        },
        iteration: 0,
        now: () => 0,
        profile: "1x",
      });
      const dataSql = executedSql.filter((sql) => !/^EXPLAIN QUERY PLAN/i.test(sql));
      const [locked, unforced] = dataSql;
      if (!locked || !unforced) {
        throw new Error(`reviewed crawl comparison did not execute both variants: ${contractId}`);
      }
      const fixtureIndex = `perf_${contract.indexEvidence.inventoryEntry.name}`;
      const normalize = (sql: string) =>
        sql
          .replace(new RegExp(`\\s+indexed\\s+by\\s+${fixtureIndex}\\b`, "gi"), "")
          .replace(/\s+/g, " ")
          .trim();

      expect(dataSql).toHaveLength(2);
      expect(locked.match(/\bINDEXED\s+BY\b/gi)).toHaveLength(1);
      expect(locked).toMatch(new RegExp(`\\bINDEXED\\s+BY\\s+${fixtureIndex}\\b`, "i"));
      expect(unforced).not.toMatch(/\bINDEXED\s+BY\b/i);
      expect(normalize(locked)).toBe(normalize(unforced));
      expect(contract.plan.policy.growingTables?.length).toBeGreaterThan(0);
      expect(contract.plan.policy.forbidTempSort).toBe(true);
    }

    expect(contracts.get("index.crawl-due-work-label-slug-node-id")?.plan?.statement.sql).toMatch(
      /where label_slug = \? and state <> 'repair' limit \?/i,
    );
    expect(contracts.get("index.crawl-due-work-parent-id-node-id")?.plan?.statement.sql).toMatch(
      /where node_id = \?.*union all.*where parent_id = \?.*node_id <> \?1.*limit \?/is,
    );
    expect(contracts.get("index.crawl-due-work-ready")?.plan?.statement.sql).toMatch(
      /state = 'ready' and node_id not in \(\?\).*order by hop, demand_rank, created_at, node_id/is,
    );
    expect(contracts.get("index.crawl-due-work-scheduled")?.plan?.statement.sql).toMatch(
      /join perf_crawl_frontier.*source\.state = 'done'.*source\.kind = 'artist'.*source\.source = 'musicbrainz'/is,
    );
    expect(contracts.get("index.crawl-projection-repairs-order")?.plan?.statement.sql).toMatch(
      /select source_type, source_id, source_epoch, source_version, created_at, updated_at/is,
    );
    expect(contracts.get("index.crawl-due-work-claim-position")?.plan?.statement.sql).not.toMatch(
      /limit/i,
    );
  });

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

      const expectedLockCount =
        inventoryName === "crawl_due_work_cleanup_idx"
          ? 4
          : runtimeLockedIndexes.has(inventoryName)
            ? 1
            : 0;
      expect(plan.statement.sql.match(/\bINDEXED\s+BY\b/gi)?.length ?? 0).toBe(expectedLockCount);

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
        await access(path);
        await expect(readFile(path, "utf8"), label).resolves.toContain(coordinate.marker);
      }),
    );
  });

  it("keeps Apple, Deezer, and Beatport catalogue worklists unforced with forced variants supplemental", async () => {
    const contract = indexEvidenceContracts().find(
      (candidate) => candidate.id === "index.tracks-capture-priority",
    );
    if (!contract?.plan || !contract.terminalProof) {
      throw new Error("capture-priority comparison contract has no plan");
    }

    const executedSql: string[] = [];
    const execution = await contract.terminalProof.execute({
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
    const [apple, deezer, beatport, forcedApple, forcedDeezer, forcedBeatport] = dataSql;
    if (!apple || !deezer || !beatport || !forcedApple || !forcedDeezer || !forcedBeatport) {
      throw new Error("capture-priority comparison did not execute all vendor variants");
    }

    expect(dataSql).toHaveLength(6);
    expect(apple).not.toMatch(/\bINDEXED\s+BY\b/i);
    expect(deezer).not.toMatch(/\bINDEXED\s+BY\b/i);
    expect(beatport).not.toMatch(/\bINDEXED\s+BY\b/i);
    expect(forcedApple).toMatch(/\bINDEXED\s+BY\s+perf_tracks_vendor_worklist_idx\b/i);
    expect(forcedDeezer).toMatch(/\bINDEXED\s+BY\s+perf_tracks_vendor_worklist_idx\b/i);
    expect(forcedBeatport).toMatch(/\bINDEXED\s+BY\s+perf_tracks_vendor_worklist_idx\b/i);
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
    for (const pattern of [
      /track_id/i,
      /isrc/i,
      /title/i,
      /artists_json/i,
      /backfill_beatport_attempted_at/i,
      /backfill_beatport_failures/i,
      /t\.is_catalogue\s*=\s*1/i,
      /t\.beatport_url\s+is\s+null/i,
      /t\.isrc\s+is\s+not\s+null/i,
      /trim\(t\.isrc\)\s*<>\s*''/i,
      /t\.backfill_beatport_done_at\s+is\s+null/i,
      /t\.backfill_beatport_attempted_at\s+is\s+null/i,
      /t\.backfill_beatport_failures\s*>\s*0/i,
      /t\.backfill_beatport_attempted_at\s*<\s*\?/i,
      /capture_priority desc/i,
      /track_id desc/i,
      /limit\s+\?/i,
    ]) {
      expect(beatport).toMatch(pattern);
    }
    expect(execution.metadata?.outputsEquivalent).toBe(true);
    expect(execution.metadata?.productionPlanViolations).toBe(0);
  });

  it("keeps the locked release-date hub cursor shapes and records their unforced counterparts", async () => {
    const contract = indexEvidenceContracts().find(
      (candidate) => candidate.id === "index.tracks-release-date-track-id",
    );
    if (!contract?.plan || !contract.terminalProof) {
      throw new Error("default hub release-date comparison contract has no plan");
    }

    const executedSql: string[] = [];
    const execution = await contract.terminalProof.execute({
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

    expect(contract.plan.statement.sql).toMatch(
      /\bINDEXED\s+BY\s+perf_tracks_release_date_track_id_idx\b/i,
    );
    expect(execution.metadata?.outputsEquivalent).toBe(true);
    expect(dataSql).toHaveLength(8);
    expect(
      dataSql
        .slice(0, 4)
        .every((sql) => /\bINDEXED\s+BY\s+perf_tracks_release_date_track_id_idx\b/i.test(sql)),
    ).toBe(true);
    expect(dataSql.slice(4).every((sql) => !/\bINDEXED\s+BY\b/i.test(sql))).toBe(true);
    expect(dataSql[0]).toMatch(
      /from perf_tracks indexed by perf_tracks_release_date_track_id_idx\s+order by/i,
    );
    expect(dataSql[2]).toMatch(/release_date is null and id < /i);
  });

  it("mirrors the six reviewed locked consumers and records an unforced same-shape plan", () => {
    const contracts = new Map(indexEvidenceContracts().map((contract) => [contract.id, contract]));
    const reviewed = [
      ["index.tracks-anchor-queue", /count\(\*\)[\s\S]*not exists/i],
      ["index.tracks-label-id", /exists \(select 1 from perf_track_artists/i],
      ["index.tracks-mb-recording-id-queue", /substr\(id, 1, 3\) != 'mb_'/i],
      ["index.artist-qualification-qualified", /perf_artist_qualification_state/i],
      ["index.tracks-anchor-order", /left join perf_findings/i],
      ["index.projection-repairs-order", /source_version/i],
    ] as const;

    for (const [id, shape] of reviewed) {
      const contract = contracts.get(id);
      if (!contract?.plan || !contract.terminalProof) {
        throw new Error(`reviewed consumer contract is missing: ${id}`);
      }
      expect(contract.plan.statement.sql).toMatch(/\bINDEXED\s+BY\b/i);
      expect(contract.plan.statement.sql).toMatch(shape);
    }
  });

  it("excludes structural drop proof latency from a single final consumer statement", async () => {
    const contract = indexEvidenceContracts().find(
      (candidate) => candidate.id === "index.artifact-change-checkpoints-running",
    );
    if (!contract?.terminalProof) {
      throw new Error("artifact checkpoint drop contract is missing");
    }

    let elapsedMs = 0;
    const execution = await contract.execute({
      client: {
        async execute(candidate) {
          const sql = typeof candidate === "string" ? candidate : candidate.sql;
          if (/sqlite_master/i.test(sql)) {
            elapsedMs += 900;
            return { rows: [] };
          }

          elapsedMs += 17;
          return {
            rows: [
              {
                consumer_id: "synthetic-consumer-000000000",
                stream: "synthetic-stream-0",
                stream_version: 1,
              },
            ],
          };
        },
      },
      iteration: 0,
      now: () => elapsedMs,
      profile: "1x",
    });
    const proof = await contract.terminalProof.execute({
      client: {
        async execute(candidate) {
          const sql = typeof candidate === "string" ? candidate : candidate.sql;
          if (/sqlite_master/i.test(sql)) {
            elapsedMs += 900;
            return { rows: [] };
          }

          elapsedMs += 17;
          return {
            rows: [
              {
                consumer_id: "synthetic-consumer-000000000",
                stream: "synthetic-stream-0",
                stream_version: 1,
              },
            ],
          };
        },
      },
      iteration: 0,
      now: () => elapsedMs,
      profile: "1x",
    });

    expect(execution.durationMs).toBe(17);
    expect(execution.metadata).toMatchObject({
      finalStatementRequestCount: 1,
      timingScope: "worst-single-final-statement",
    });
    expect(proof.metadata).toMatchObject({
      measuredRequestCount: 3,
      terminalPlanRequestCount: 1,
      terminalProofRequestCount: 2,
      totalRequestCount: 6,
    });
  });

  it("budgets a multi-consumer proof by its slowest final statement", async () => {
    const contract = indexEvidenceContracts().find(
      (candidate) => candidate.id === "index.tracks-release-date-track-id",
    );
    if (!contract) {
      throw new Error("default hub release-date comparison contract is missing");
    }

    let elapsedMs = 0;
    const report = await runPerformanceContracts({
      client: {
        async execute(candidate) {
          const sql = typeof candidate === "string" ? candidate : candidate.sql;
          if (/^EXPLAIN QUERY PLAN/i.test(sql)) {
            elapsedMs += 900;
            return {
              rows: [
                {
                  detail:
                    "SEARCH perf_tracks USING COVERING INDEX perf_tracks_release_date_track_id_idx",
                },
              ],
            };
          }
          if (/sqlite_master/i.test(sql)) {
            elapsedMs += 900;
            return { rows: [] };
          }
          if (/\bINDEXED\s+BY\b/i.test(sql)) {
            elapsedMs += 900;
          } else {
            elapsedMs += /release_date is null/i.test(sql) ? 300 : 20;
          }

          return { rows: [{ rd: "2026", track_id: "synthetic-track-000000000" }] };
        },
      },
      contracts: [contract],
      now: () => elapsedMs,
      profile: "1x",
    });
    const evidence = report.contracts[0];

    expect(evidence?.durationMs).toEqual({ max: 900, p50: 900, p95: 900, p99: 900 });
    expect(evidence?.metadata[0]).toMatchObject({
      finalStatementRequestCount: 4,
      measuredRequestCount: 12,
      terminalPlanRequestCount: 1,
      terminalProofRequestCount: 16,
      timingScope: "worst-single-final-statement",
      totalRequestCount: 29,
    });
    expect(evidence?.budget.failures).toEqual(["p95 900ms exceeds 250ms"]);
    expect(evidence?.validationFailures).toEqual([]);
  });

  it("runs a later production batch before terminal comparison-index proof", async () => {
    const comparison = indexEvidenceContracts().find(
      (candidate) => candidate.id === "index.tracks-capture-priority",
    );
    const dueWork = selectPerformanceContracts(["fixture.due-work-claim"])[0];
    if (!comparison || !dueWork) {
      throw new Error("comparison index or due-work contract is missing");
    }

    const client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });
    const progress: { contractId?: string; phase: string }[] = [];
    try {
      await applyFixtureSchema(client);
      await writeFixture(client, "1x", { counts: createCiFixtureCounts("1x", 512) });
      const report = await runPerformanceContracts({
        client,
        contracts: [comparison, dueWork],
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
        (event) =>
          event.contractId === "index.tracks-capture-priority" && event.phase === "terminal-proof",
      );

      expect(comparisonReport?.passed).toBe(true);
      expect(comparisonReport?.metadata[0]?.outputsEquivalent).toBe(true);
      expect(dueWorkReport?.passed).toBe(true);
      expect(dueWorkMeasurement).toBeGreaterThanOrEqual(0);
      expect(comparisonProof).toBeGreaterThan(dueWorkMeasurement);
    } finally {
      client.close();
    }
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

  it("locks every bounded cleanup branch and leaves the artist-rule lookup sargable", () => {
    const cleanup = indexEvidenceContracts().find(
      (candidate) => candidate.id === "index.crawl-due-work-cleanup",
    );
    const artistRule = indexEvidenceContracts().find(
      (candidate) => candidate.id === "index.artist-rules-crawl-lookup",
    );
    if (!cleanup?.plan || !artistRule?.plan) {
      throw new Error("crawl cleanup evidence contracts are incomplete");
    }

    expect(INDEX_EVIDENCE_RUNTIME_LOCKED_INDEXES).toContain("crawl_due_work_cleanup_idx");
    expect(
      cleanup.plan.statement.sql.match(/\bINDEXED\s+BY\s+perf_crawl_due_work_cleanup_idx\b/gi),
    ).toHaveLength(4);
    expect(cleanup.plan.statement.sql).not.toMatch(/\bnot\s+indexed\b/i);
    expect(artistRule.plan.statement.sql).not.toMatch(/\bINDEXED\s+BY\b/i);
    expect(artistRule.plan.statement.sql).toContain(
      "artist_mbid = substr('musicbrainz:artist:synthetic-artist-000000000'",
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
    expect(audit?.missingPlanEvidence).toHaveLength(69);
    expect(audit?.missingProfileEvidence).toEqual([]);
    expect(audit?.passed).toBe(false);
  });

  it("runs all declared evidence at every local profile and retains the proven singleton", async () => {
    const contracts = indexEvidenceContracts();

    expect(contracts).toHaveLength(69);
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
        const audit = report.indexAudit;
        if (!audit) {
          throw new Error("performance report omitted its index audit");
        }
        expect(audit.passed).toBe(true);
        expect(audit.totals).toEqual({
          databaseScaleIndexes: 32,
          evidenceContracts: 69,
          indexes: 64,
          tracksIndexes: 32,
        });
        expect(audit.decisions.counts).toEqual({ add: 0, drop: 6, keep: 58 });
        expect(audit.productionInventory).toEqual({
          currentFinalSchemaBeforeContraction: { indexes: 180, tracksIndexes: 32 },
          finalSchemaAfterContraction: { indexes: 174, tracksIndexes: 30 },
        });
        expect(audit.missingConsumers).toEqual([]);
        expect(audit.missingPlanEvidence).toEqual([]);
        expect(audit.missingProfileEvidence).toEqual([]);
        expect(audit.profileEvidence[profile]).toEqual({
          declaredContracts: 69,
          observedContracts: 69,
        });

        const auditEntries = audit.entries;
        const evidence = auditEntries.flatMap((entry) => entry.contracts);
        expect(auditEntries).toHaveLength(64);
        expect(evidence).toHaveLength(69);
        expect(
          evidence.every(
            (contractEvidence) =>
              contractEvidence.passed &&
              contractEvidence.plan !== null &&
              contractEvidence.plan.violations.length === 0 &&
              Number(contractEvidence.metadata?.minimumResultRows) <=
                contractEvidence.resultRowCount?.p50 &&
              contractEvidence.metadata?.timingScope === "worst-single-final-statement" &&
              Number(contractEvidence.metadata.finalStatementRequestCount) >= 1 &&
              Number(contractEvidence.metadata.measuredRequestCount) >= 1 &&
              Number(contractEvidence.metadata.terminalPlanRequestCount) === 1 &&
              Number(contractEvidence.metadata.terminalProofRequestCount) >= 1 &&
              Number(contractEvidence.metadata.totalRequestCount) ===
                Number(contractEvidence.metadata.measuredRequestCount) +
                  Number(contractEvidence.metadata.terminalPlanRequestCount) +
                  Number(contractEvidence.metadata.terminalProofRequestCount) &&
              contractEvidence.requiredProfiles.join(",") === "1x,2x,4x",
          ),
        ).toBe(true);

        const releaseDateIndex = auditEntries.find(
          (entry) => entry.name === "tracks_release_date_idx",
        );
        expect(releaseDateIndex?.decision).toBe("keep");
        expect(releaseDateIndex?.contracts).toHaveLength(6);
        expect(releaseDateIndex?.contracts.map((contract) => contract.contractId)).toEqual([
          "index.tracks-release-date-fresh",
          "index.tracks-release-date-public-findings",
          "index.tracks-release-date-public-records",
          "index.tracks-release-date-year",
          "index.tracks-release-date-default-hub",
          "index.tracks-release-date-search",
        ]);
        expect(
          releaseDateIndex?.contracts.every(
            (contract) =>
              contract.metadata?.outputsEquivalent === true &&
              contract.metadata.requiredIndex === "tracks_release_date_idx" &&
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
        const freshEvidence = releaseDateIndex?.contracts.find(
          (contract) => contract.contractId === "index.tracks-release-date-fresh",
        );
        const freshPlans = JSON.parse(String(freshEvidence?.metadata?.productionPlanDetails)) as
          | string[][]
          | undefined;
        expect(freshPlans).toHaveLength(4);
        expect(
          freshPlans?.every((details) => details.some((detail) => /USING INDEX/.test(detail))),
        ).toBe(true);
        const publicFindingsEvidence = releaseDateIndex?.contracts.find(
          (contract) => contract.contractId === "index.tracks-release-date-public-findings",
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
        const publicRecordsEvidence = releaseDateIndex?.contracts.find(
          (contract) => contract.contractId === "index.tracks-release-date-public-records",
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
        expect(indexes.rows).toEqual([{ name: "perf_tracks_release_date_idx" }]);
        const allDroppedIndexes = [
          "perf_artifact_change_checkpoints_running_idx",
          "perf_artifact_change_consumers_compaction_idx",
          "perf_artifact_changes_created_seq_idx",
          "perf_operation_receipts_operation_audit_idx",
          "perf_tracks_capture_priority_idx",
          "perf_tracks_nearest_finding_score_idx",
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
