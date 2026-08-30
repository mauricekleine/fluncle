import { type Client, type InStatement } from "@libsql/client";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createIntegrationDb,
  seedAlbum,
  seedArtist,
  seedCatalogueTrack,
  seedLabel,
  seedTrack,
} from "../src/lib/server/integration-db";
import {
  initializePublicProjectionTestState,
  readPublicProjectionMaintenanceSnapshot,
  settlePublicProjectionTestState,
} from "./lib/public-projection-test-state";
import {
  HUB_COUNTS_BACKFILL_COMPLETE_VALUE,
  HUB_COUNTS_BACKFILL_MARKER_KEY,
  backfillHubCounts,
  createHubCountStageTableName,
} from "./backfill-hub-counts";

// The keystone-2 backfill (docs/db-scale-backlog Wave 2 #2): the migration adds the maintained
// per-entity counters with DEFAULT 0, so every EXISTING row reads zero while the edges it should be
// counting already exist. This is the ONE recompute-from-truth in the design — the exact shape the
// write paths are forbidden to use — so it is guarded to run once and skipped ever after. Driven
// against the real migrated schema so the `UPDATE … FROM (… GROUP BY …)` under test is
// byte-identical to production's.

let db: Client;

async function counts(
  table: "albums" | "artists" | "labels",
  id: string,
): Promise<{ certified: number; renderable: number }> {
  const result = await db.execute({
    args: [id],
    sql: `select renderable_track_count as renderable, certified_finding_count as certified
          from ${table} where id = ?`,
  });
  const row = result.rows[0];

  return { certified: Number(row?.certified ?? -1), renderable: Number(row?.renderable ?? -1) };
}

function statementSql(statement: InStatement): string {
  return typeof statement === "string" ? statement : statement.sql;
}

function isMarkerClaim(statement: InStatement): boolean {
  return statementSql(statement).includes("settings.value <> ?");
}

function isMarkerCompletion(statement: InStatement): boolean {
  return statementSql(statement).includes(
    "update settings set value = ? where key = ? and value = ?",
  );
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {
    throw new Error("deferred resolved before initialization");
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

async function hubCountStageTables(): Promise<string[]> {
  const result = await db.execute(
    `select name from sqlite_master
     where type = 'table' and name like 'backfill_hub_counts_%'
     order by name`,
  );

  return result.rows.map((row) => {
    if (typeof row.name !== "string") {
      throw new Error("staging table name must be text");
    }

    return row.name;
  });
}

async function completionMarker(): Promise<string | undefined> {
  const result = await db.execute({
    args: [HUB_COUNTS_BACKFILL_MARKER_KEY],
    sql: `select value from settings where key = ? limit 1`,
  });
  const value = result.rows[0]?.value;

  return typeof value === "string" ? value : undefined;
}

function expectRunningMarker(value: string | undefined): void {
  expect(value).toMatch(
    /^running:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
}

beforeEach(async () => {
  db = await createIntegrationDb();
  await initializePublicProjectionTestState(db);
  // The graph history leaves behind: one label + one album + one artist carrying two certified
  // findings and one raw catalogue track, plus an EMPTY label nothing points at.
  await seedLabel(db, { id: "lab-1", name: "Hospital Records", slug: "hospital-records" });
  await seedLabel(db, { id: "lab-empty", name: "Nothing Here", slug: "nothing-here" });
  await seedAlbum(db, { id: "alb-1", name: "Sight To Behold", slug: "sight-to-behold" });
  await seedArtist(db, { id: "art-1", name: "Logistics", slug: "logistics" });
  await seedTrack(db, { logId: "004.7.2A", trackId: "t-cert-0000000000000a" });
  await seedTrack(db, { logId: "004.7.2B", trackId: "t-cert-0000000000000b" });
  await seedCatalogueTrack(db, { trackId: "t-cat-00000000000000a" });
  // The edges, written RAW (no deltas) — exactly the pre-backfill state history is in.
  await db.batch(
    [
      `update tracks set label_id = 'lab-1', album_id = 'alb-1'`,
      `insert into track_artists (track_id, artist_id, position)
       values ('t-cert-0000000000000a', 'art-1', 1),
              ('t-cert-0000000000000b', 'art-1', 1),
              ('t-cat-00000000000000a', 'art-1', 1)`,
    ],
    "write",
  );
});

describe("backfillHubCounts", () => {
  it("materializes each archive aggregate once in one atomic hosted-compatible batch", async () => {
    const originalBatch = db.batch.bind(db);
    const batches: InStatement[][] = [];
    vi.spyOn(db, "batch").mockImplementation(async (statements, mode) => {
      batches.push([...statements]);

      return originalBatch(statements, mode);
    });

    await backfillHubCounts(db, { force: true });

    const shapes = [
      {
        entity: "labels",
        entityDriver: "from labels left join",
        groupBy: "group by label_id",
        hasProjectionRepair: false,
        source: "from tracks where label_id is not null group by label_id",
        stagePrefix: "backfill_hub_counts_labels_stage_",
      },
      {
        entity: "albums",
        entityDriver: "from albums left join",
        groupBy: "group by album_id",
        hasProjectionRepair: false,
        source: "from tracks where album_id is not null group by album_id",
        stagePrefix: "backfill_hub_counts_albums_stage_",
      },
      {
        entity: "artists",
        entityDriver: "from artists left join",
        groupBy: "group by ta.artist_id",
        hasProjectionRepair: false,
        source:
          "from track_artists ta join tracks t on t.track_id = ta.track_id group by ta.artist_id",
        stagePrefix: "backfill_hub_counts_artists_stage_",
      },
    ] as const;

    expect(batches).toHaveLength(shapes.length);
    for (const [index, shape] of shapes.entries()) {
      const sql = (batches[index] ?? []).map((statement) => statementSql(statement).toLowerCase());
      const combined = sql.join("\n");
      const legacyMarker = sql.find((statement) => statement.includes("insert into due_work"));
      const projectionRepair = sql.find((statement) =>
        statement.includes("insert into projection_repairs"),
      );
      const createMatch = /^create table ([a-z0-9_]+) \(/u.exec(sql[0] ?? "");
      const stageTable = createMatch?.[1];
      if (!stageTable) {
        throw new Error("hub-count batch must begin by creating its staging table");
      }
      const normalizedStage = (sql[1] ?? "").replaceAll(/\s+/g, " ");

      expect(stageTable).toMatch(new RegExp(`^${shape.stagePrefix}[0-9a-f]{32}$`, "u"));
      expect(sql[0]).not.toContain("if not exists");
      expect(sql[1]).toContain(`insert into ${stageTable}`);
      expect(combined).not.toContain("temp");
      expect(combined).not.toContain("without rowid");
      expect(combined.split(shape.groupBy)).toHaveLength(2);
      expect(normalizedStage).toContain(shape.source);
      expect(normalizedStage).toContain(shape.entityDriver);
      expect(normalizedStage).toContain(
        `where ${shape.entity}.renderable_track_count <> coalesce(src.renderable, 0)`,
      );
      expect(normalizedStage).toContain(
        `or ${shape.entity}.certified_finding_count <> coalesce(src.certified, 0)`,
      );
      expect(legacyMarker).toContain(`select subject_id from ${stageTable}`);
      if (shape.hasProjectionRepair) {
        expect(projectionRepair).toContain(`select subject_id from ${stageTable}`);
      } else {
        expect(projectionRepair).toBeUndefined();
      }
      expect(sql.at(-2)).toContain(`update ${shape.entity}`);
      expect(sql.at(-2)).toContain(`from ${stageTable} staged`);
      expect(sql.at(-1)).toBe(`drop table ${stageTable}`);
    }
    expect(await hubCountStageTables()).toEqual([]);
  });

  it("accepts only canonical UUID-backed staging identifiers", () => {
    expect(createHubCountStageTableName("labels", "123e4567-e89b-42d3-a456-426614174000")).toBe(
      "backfill_hub_counts_labels_stage_123e4567e89b42d3a456426614174000",
    );

    for (const unsafeRunId of [
      "",
      "123E4567-E89B-42D3-A456-426614174000",
      "123e4567-e89b-42d3-a456-426614174000;drop table labels",
      "../../labels",
    ]) {
      expect(() => createHubCountStageTableName("labels", unsafeRunId)).toThrow(
        "staging run id must be a canonical UUID",
      );
    }
  });

  it("retries a pre-commit claim ambiguity that leaves old completion in place", async () => {
    await backfillHubCounts(db);
    const originalExecute = db.execute.bind(db);
    let claimWrites = 0;
    vi.spyOn(db, "execute").mockImplementation(async (statement) => {
      if (isMarkerClaim(statement)) {
        claimWrites += 1;
        if (claimWrites === 1) {
          throw new Error("claim failed before commit");
        }
      }

      return originalExecute(statement);
    });

    const result = await backfillHubCounts(db, { force: true });

    expect(result.skipped).toBe(false);
    expect(claimWrites).toBe(2);
    expect(await completionMarker()).toBe(HUB_COUNTS_BACKFILL_COMPLETE_VALUE);
  });

  it("recognizes an after-commit ambiguous claim by reading back its own token", async () => {
    const originalExecute = db.execute.bind(db);
    let claimWrites = 0;
    vi.spyOn(db, "execute").mockImplementation(async (statement) => {
      if (isMarkerClaim(statement)) {
        claimWrites += 1;
        if (claimWrites === 1) {
          await originalExecute(statement);
          throw new Error("claim response lost after commit");
        }
      }

      return originalExecute(statement);
    });

    const result = await backfillHubCounts(db);

    expect(result.filled).toEqual({ albums: 1, artists: 1, labels: 1 });
    expect(claimWrites).toBe(1);
    expect(await completionMarker()).toBe(HUB_COUNTS_BACKFILL_COMPLETE_VALUE);
  });

  it.each(["before", "after"] as const)(
    "recovers when completion is ambiguous %s commit",
    async (ambiguity) => {
      const originalExecute = db.execute.bind(db);
      let completionWrites = 0;
      vi.spyOn(db, "execute").mockImplementation(async (statement) => {
        if (isMarkerCompletion(statement)) {
          completionWrites += 1;
          if (completionWrites === 1) {
            if (ambiguity === "after") {
              await originalExecute(statement);
            }
            throw new Error(`completion response lost ${ambiguity} commit`);
          }
        }

        return originalExecute(statement);
      });

      const result = await backfillHubCounts(db);

      expect(result.filled).toEqual({ albums: 1, artists: 1, labels: 1 });
      expect(completionWrites).toBe(ambiguity === "before" ? 2 : 1);
      expect(await completionMarker()).toBe(HUB_COUNTS_BACKFILL_COMPLETE_VALUE);
    },
  );

  it("recovers a stale running marker by claiming a fresh token", async () => {
    const staleRunId = "123e4567-e89b-42d3-a456-426614174000";
    await db.execute({
      args: [HUB_COUNTS_BACKFILL_MARKER_KEY, `running:${staleRunId}`],
      sql: `insert into settings (key, value) values (?, ?)`,
    });

    const result = await backfillHubCounts(db);

    expect(result.filled).toEqual({ albums: 1, artists: 1, labels: 1 });
    expect(await completionMarker()).toBe(HUB_COUNTS_BACKFILL_COMPLETE_VALUE);
  });

  it("throws before archive mutation when run ownership cannot be confirmed", async () => {
    const originalExecute = db.execute.bind(db);
    const batch = vi.spyOn(db, "batch");
    let claimWrites = 0;
    vi.spyOn(db, "execute").mockImplementation(async (statement) => {
      if (isMarkerClaim(statement)) {
        claimWrites += 1;
        throw new Error("claim failed before commit");
      }

      return originalExecute(statement);
    });

    await expect(backfillHubCounts(db)).rejects.toThrow(
      "could not durably establish run ownership; no backfill mutation ran",
    );

    expect(claimWrites).toBe(3);
    expect(batch).not.toHaveBeenCalled();
    expect(await completionMarker()).toBeUndefined();
  });

  it("stops an older overlapping run before its next corpus pass", async () => {
    const originalExecute = db.execute.bind(db);
    const originalBatch = db.batch.bind(db);
    const firstRunAtPass = deferred();
    const releaseFirstRun = deferred();
    const secondRunAtPass = deferred();
    const releaseSecondRun = deferred();
    const claimedTokens: string[] = [];
    const executedStageSuffixes: string[] = [];
    let firstStageSuffix: string | undefined;
    let secondStageSuffix: string | undefined;

    vi.spyOn(db, "execute").mockImplementation(async (statement) => {
      if (isMarkerClaim(statement) && typeof statement !== "string") {
        const token = statement.args?.[1];
        if (typeof token === "string" && !claimedTokens.includes(token)) {
          claimedTokens.push(token);
        }
      }

      return originalExecute(statement);
    });
    vi.spyOn(db, "batch").mockImplementation(async (statements, mode) => {
      const createSql = statementSql(statements[0] ?? "");
      const suffix = /_stage_([0-9a-f]{32})/u.exec(createSql)?.[1];
      if (!suffix) {
        throw new Error("hub-count batch must expose its run suffix");
      }

      if (!firstStageSuffix) {
        firstStageSuffix = suffix;
        firstRunAtPass.resolve();
        await releaseFirstRun.promise;
      } else if (suffix !== firstStageSuffix) {
        secondStageSuffix = suffix;
        secondRunAtPass.resolve();
        await releaseSecondRun.promise;
      }

      const results = await originalBatch(statements, mode);
      executedStageSuffixes.push(suffix);

      return results;
    });

    const firstRun = backfillHubCounts(db);
    await firstRunAtPass.promise;
    const secondRun = backfillHubCounts(db);
    await secondRunAtPass.promise;

    releaseFirstRun.resolve();
    await expect(firstRun).rejects.toThrow("run ownership changed before the albums corpus pass");
    expect(claimedTokens).toHaveLength(2);
    expect(await completionMarker()).toBe(claimedTokens[1]);
    if (!firstStageSuffix || !secondStageSuffix) {
      throw new Error("both overlapping runs must reach their first corpus pass");
    }
    expect(executedStageSuffixes).toEqual([firstStageSuffix]);

    releaseSecondRun.resolve();
    const secondResult = await secondRun;

    expect(secondResult.skipped).toBe(false);
    expect(executedStageSuffixes).toEqual([
      firstStageSuffix,
      secondStageSuffix,
      secondStageSuffix,
      secondStageSuffix,
    ]);
    expect(await completionMarker()).toBe(HUB_COUNTS_BACKFILL_COMPLETE_VALUE);
  });

  it("never shares staging relations between concurrent forced runs", async () => {
    const originalBatch = db.batch.bind(db);
    const stageTables: string[] = [];
    vi.spyOn(db, "batch").mockImplementation(async (statements, mode) => {
      const createSql = statementSql(statements[0] ?? "").toLowerCase();
      const stageTable = /^create table ([a-z0-9_]+) \(/u.exec(createSql)?.[1];
      if (!stageTable) {
        throw new Error("hub-count batch must begin by creating its staging table");
      }
      stageTables.push(stageTable);

      return originalBatch(statements, mode);
    });

    const runs = await Promise.allSettled([
      backfillHubCounts(db, { force: true }),
      backfillHubCounts(db, { force: true }),
    ]);

    expect(runs.some((run) => run.status === "fulfilled")).toBe(true);
    for (const run of runs) {
      if (run.status === "rejected") {
        expect(String(run.reason)).toContain("run ownership changed");
      }
    }
    expect(stageTables.length).toBeGreaterThanOrEqual(3);
    expect(stageTables.length).toBeLessThanOrEqual(6);
    expect(new Set(stageTables).size).toBe(stageTables.length);
    for (const key of ["labels", "albums", "artists"] as const) {
      const passTables = stageTables.filter((table) =>
        table.startsWith(`backfill_hub_counts_${key}_stage_`),
      );
      expect(passTables.length).toBeGreaterThanOrEqual(1);
      expect(passTables.length).toBeLessThanOrEqual(2);
    }
    expect(await counts("labels", "lab-1")).toEqual({ certified: 2, renderable: 3 });
    expect(await completionMarker()).toBe(HUB_COUNTS_BACKFILL_COMPLETE_VALUE);
    expect(await hubCountStageTables()).toEqual([]);
  });

  it("counts every entity's linked tracks and its certified subset, in one pass per table", async () => {
    const result = await backfillHubCounts(db);

    expect(result.skipped).toBe(false);
    expect(result.filled).toEqual({ albums: 1, artists: 1, labels: 1 });
    // Three linked tracks, two of them certified (`is_catalogue = 0`).
    expect(await counts("labels", "lab-1")).toEqual({ certified: 2, renderable: 3 });
    expect(await counts("albums", "alb-1")).toEqual({ certified: 2, renderable: 3 });
    expect(await counts("artists", "art-1")).toEqual({ certified: 2, renderable: 3 });
    const markers = await db.execute({
      sql: `select subject_type, subject_id from due_work where work_kind = 'source-repair'
            order by subject_type, subject_id`,
    });
    expect(markers.rows.map((row) => [row.subject_type, row.subject_id])).toEqual([
      ["album", "alb-1"],
      ["artist", "art-1"],
      ["label", "lab-1"],
    ]);
    expect(await completionMarker()).toBe(HUB_COUNTS_BACKFILL_COMPLETE_VALUE);
  });

  it("stages zero truth when an entity loses its final linked track", async () => {
    await backfillHubCounts(db);
    await db.batch(
      [
        `update tracks set label_id = null, album_id = null`,
        `delete from track_artists where artist_id = 'art-1'`,
      ],
      "write",
    );

    const result = await backfillHubCounts(db, { force: true });

    expect(result.filled).toEqual({ albums: 1, artists: 1, labels: 1 });
    expect(await counts("labels", "lab-1")).toEqual({ certified: 0, renderable: 0 });
    expect(await counts("albums", "alb-1")).toEqual({ certified: 0, renderable: 0 });
    expect(await counts("artists", "art-1")).toEqual({ certified: 0, renderable: 0 });
    expect(await completionMarker()).toBe(HUB_COUNTS_BACKFILL_COMPLETE_VALUE);
  });

  it("leaves an entity with no linked tracks at the DDL default of 0", async () => {
    await backfillHubCounts(db);

    expect(await counts("labels", "lab-empty")).toEqual({ certified: 0, renderable: 0 });
  });

  it("adopts a marker-less legacy-complete database with one recompute, then stays a no-op", async () => {
    await backfillHubCounts(db, { force: true });
    await db.execute({
      args: [HUB_COUNTS_BACKFILL_MARKER_KEY],
      sql: `delete from settings where key = ?`,
    });
    const originalBatch = db.batch.bind(db);
    const batches: InStatement[][] = [];
    vi.spyOn(db, "batch").mockImplementation(async (statements, mode) => {
      batches.push([...statements]);

      return originalBatch(statements, mode);
    });

    const adopted = await backfillHubCounts(db);
    const skipped = await backfillHubCounts(db);

    expect(adopted).toEqual({ filled: { albums: 0, artists: 0, labels: 0 }, skipped: false });
    expect(skipped).toEqual({ skipped: true });
    expect(batches).toHaveLength(3);
    expect(await completionMarker()).toBe(HUB_COUNTS_BACKFILL_COMPLETE_VALUE);
  });

  it("SKIPS only on the durable completion marker — the deploy-time no-op", async () => {
    await backfillHubCounts(db);
    // Drift the counts, then re-run: the marker must keep the deploy no-op and change nothing, so a
    // real maintenance bug is left visible for the reconciliation sweep rather than papered over.
    await db.execute(`update labels set certified_finding_count = 99 where id = 'lab-1'`);

    const result = await backfillHubCounts(db);

    expect(result.skipped).toBe(true);
    expect(result.filled).toBeUndefined();
    expect(await counts("labels", "lab-1")).toEqual({ certified: 99, renderable: 3 });
  });

  it("--force re-fills over seeded counts, correcting drift", async () => {
    await backfillHubCounts(db);
    await db.execute(`update labels set certified_finding_count = 99 where id = 'lab-1'`);

    const result = await backfillHubCounts(db, { force: true });

    expect(result.skipped).toBe(false);
    expect(await counts("labels", "lab-1")).toEqual({ certified: 2, renderable: 3 });
  });

  it("is idempotent under --force — a second forced run lands the same numbers", async () => {
    await backfillHubCounts(db, { force: true });
    expect(await readPublicProjectionMaintenanceSnapshot(db)).toEqual({
      aggregate: { projectionEpoch: 0, ready: true, sourceEpoch: 0 },
      artists: { projectionEpoch: 0, ready: true, sourceEpoch: 0 },
      repairs: [],
    });
    await settlePublicProjectionTestState(db);
    const ready = await readPublicProjectionMaintenanceSnapshot(db);
    expect(ready).toEqual({
      aggregate: { projectionEpoch: 0, ready: true, sourceEpoch: 0 },
      artists: { projectionEpoch: 0, ready: true, sourceEpoch: 0 },
      repairs: [],
    });

    const second = await backfillHubCounts(db, { force: true });

    expect(second.filled).toEqual({ albums: 0, artists: 0, labels: 0 });
    expect(await counts("artists", "art-1")).toEqual({ certified: 2, renderable: 3 });
    expect(await readPublicProjectionMaintenanceSnapshot(db)).toEqual(ready);
  });

  it("replaces prior completion with owned running state so forced failure stays retryable", async () => {
    await backfillHubCounts(db);
    await db.execute(`update artists set renderable_track_count = 99 where id = 'art-1'`);
    await db.execute(`create trigger reject_forced_artist_hub_count_apply
      before update of renderable_track_count, certified_finding_count on artists
      begin
        select raise(abort, 'forced artist hub count apply rejected');
      end`);

    await expect(backfillHubCounts(db, { force: true })).rejects.toThrow(
      "forced artist hub count apply rejected",
    );

    expectRunningMarker(await completionMarker());
    expect(await counts("artists", "art-1")).toEqual({ certified: 2, renderable: 99 });
    expect(await hubCountStageTables()).toEqual([]);

    await db.execute(`drop trigger reject_forced_artist_hub_count_apply`);
    const recovered = await backfillHubCounts(db);

    expect(recovered).toEqual({
      filled: { albums: 0, artists: 1, labels: 0 },
      skipped: false,
    });
    expect(await counts("artists", "art-1")).toEqual({ certified: 2, renderable: 3 });
    expect(await completionMarker()).toBe(HUB_COUNTS_BACKFILL_COMPLETE_VALUE);
  });

  it.each([
    {
      failedTable: "labels" as const,
      markersAfterFailure: [],
      retryFilled: { albums: 1, artists: 1, labels: 1 },
      valuesAfterFailure: { albums: 0, artists: 0, labels: 0 },
    },
    {
      failedTable: "albums" as const,
      markersAfterFailure: [["label", "lab-1"]],
      retryFilled: { albums: 1, artists: 1, labels: 0 },
      valuesAfterFailure: { albums: 0, artists: 0, labels: 3 },
    },
    {
      failedTable: "artists" as const,
      markersAfterFailure: [
        ["album", "alb-1"],
        ["label", "lab-1"],
      ],
      retryFilled: { albums: 0, artists: 1, labels: 0 },
      valuesAfterFailure: { albums: 3, artists: 0, labels: 3 },
    },
  ])(
    "withholds completion, rolls back the $failedTable pass, and completes on retry",
    async ({ failedTable, markersAfterFailure, retryFilled, valuesAfterFailure }) => {
      const triggerName = `reject_${failedTable}_hub_count_apply`;
      await db.execute(`create trigger ${triggerName}
        before update of renderable_track_count, certified_finding_count on ${failedTable}
        begin
          select raise(abort, '${failedTable} hub count apply rejected');
        end`);

      await expect(backfillHubCounts(db, { force: true })).rejects.toThrow(
        `${failedTable} hub count apply rejected`,
      );

      expectRunningMarker(await completionMarker());
      expect(await counts("labels", "lab-1")).toEqual({
        certified: valuesAfterFailure.labels === 0 ? 0 : 2,
        renderable: valuesAfterFailure.labels,
      });
      expect(await counts("albums", "alb-1")).toEqual({
        certified: valuesAfterFailure.albums === 0 ? 0 : 2,
        renderable: valuesAfterFailure.albums,
      });
      expect(await counts("artists", "art-1")).toEqual({
        certified: valuesAfterFailure.artists === 0 ? 0 : 2,
        renderable: valuesAfterFailure.artists,
      });
      const legacyMarkers = await db.execute(
        `select subject_type, subject_id from due_work where work_kind = 'source-repair'
         order by subject_type, subject_id`,
      );
      expect(legacyMarkers.rows.map((row) => [row.subject_type, row.subject_id])).toEqual(
        markersAfterFailure,
      );
      expect(await hubCountStageTables()).toEqual([]);

      await db.execute(`drop trigger ${triggerName}`);
      const recovered = await backfillHubCounts(db);

      expect(recovered).toEqual({ filled: retryFilled, skipped: false });
      expect(await counts("labels", "lab-1")).toEqual({ certified: 2, renderable: 3 });
      expect(await counts("albums", "alb-1")).toEqual({ certified: 2, renderable: 3 });
      expect(await counts("artists", "art-1")).toEqual({ certified: 2, renderable: 3 });
      expect(await completionMarker()).toBe(HUB_COUNTS_BACKFILL_COMPLETE_VALUE);
      expect(await hubCountStageTables()).toEqual([]);
    },
  );
});
