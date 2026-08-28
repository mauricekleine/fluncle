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
import { backfillHubCounts } from "./backfill-hub-counts";

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

async function tempHubCountTables(): Promise<string[]> {
  const result = await db.execute(
    `select name from sqlite_temp_master
     where type = 'table' and name like 'backfill_hub_counts_%'
     order by name`,
  );

  return result.rows.map((row) => {
    if (typeof row.name !== "string") {
      throw new Error("TEMP table name must be text");
    }

    return row.name;
  });
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
  it("materializes each archive aggregate exactly once and reuses its TEMP subjects", async () => {
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
        groupBy: "group by label_id",
        hasProjectionRepair: true,
        source: "from tracks where label_id is not null group by label_id",
        stage: "backfill_hub_counts_labels_stage",
      },
      {
        entity: "albums",
        groupBy: "group by album_id",
        hasProjectionRepair: false,
        source: "from tracks where album_id is not null group by album_id",
        stage: "backfill_hub_counts_albums_stage",
      },
      {
        entity: "artists",
        groupBy: "group by ta.artist_id",
        hasProjectionRepair: true,
        source:
          "from track_artists ta join tracks t on t.track_id = ta.track_id group by ta.artist_id",
        stage: "backfill_hub_counts_artists_stage",
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
      const normalizedStage = (sql[2] ?? "").replaceAll(/\s+/g, " ");

      expect(sql[0]).toContain(`create temp table if not exists ${shape.stage}`);
      expect(sql[1]).toBe(`delete from temp.${shape.stage}`);
      expect(sql[2]).toContain(`insert into temp.${shape.stage}`);
      expect(combined.split(shape.groupBy)).toHaveLength(2);
      expect(normalizedStage).toContain(shape.source);
      expect(normalizedStage).toContain(
        `where ${shape.entity}.renderable_track_count <> src.renderable`,
      );
      expect(normalizedStage).toContain(
        `or ${shape.entity}.certified_finding_count <> src.certified`,
      );
      expect(legacyMarker).toContain(`select subject_id from temp.${shape.stage}`);
      if (shape.hasProjectionRepair) {
        expect(projectionRepair).toContain(`select subject_id from temp.${shape.stage}`);
      } else {
        expect(projectionRepair).toBeUndefined();
      }
      expect(sql.at(-2)).toContain(`update ${shape.entity}`);
      expect(sql.at(-2)).toContain(`from temp.${shape.stage} staged`);
      expect(sql.at(-1)).toBe(`drop table temp.${shape.stage}`);
    }
    expect(await tempHubCountTables()).toEqual([]);
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
  });

  it("leaves an entity with no linked tracks at the DDL default of 0", async () => {
    await backfillHubCounts(db);

    expect(await counts("labels", "lab-empty")).toEqual({ certified: 0, renderable: 0 });
  });

  it("SKIPS on an already-backfilled database — the deploy-time no-op", async () => {
    await backfillHubCounts(db);
    // Drift the counts, then re-run: the guard must see the seeded state and change nothing, so a
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
      artists: { projectionEpoch: 0, ready: false, sourceEpoch: 2 },
      repairs: [
        {
          projection: "artist_qualification",
          sourceEpoch: 2,
          subjectId: "art-1",
          subjectType: "artist",
        },
        {
          projection: "artist_qualification",
          sourceEpoch: 1,
          subjectId: "lab-1",
          subjectType: "label",
        },
      ],
    });
    await settlePublicProjectionTestState(db);
    const ready = await readPublicProjectionMaintenanceSnapshot(db);
    expect(ready).toEqual({
      aggregate: { projectionEpoch: 0, ready: true, sourceEpoch: 0 },
      artists: { projectionEpoch: 2, ready: true, sourceEpoch: 2 },
      repairs: [],
    });

    const second = await backfillHubCounts(db, { force: true });

    expect(second.filled).toEqual({ albums: 0, artists: 0, labels: 0 });
    expect(await counts("artists", "art-1")).toEqual({ certified: 2, renderable: 3 });
    expect(await readPublicProjectionMaintenanceSnapshot(db)).toEqual(ready);
  });

  it("rolls back counts and both marker rails when a staged apply fails", async () => {
    const before = await readPublicProjectionMaintenanceSnapshot(db);
    await db.execute(`create trigger reject_label_hub_count_apply
      before update of renderable_track_count, certified_finding_count on labels
      begin
        select raise(abort, 'label hub count apply rejected');
      end`);

    await expect(backfillHubCounts(db, { force: true })).rejects.toThrow(
      "label hub count apply rejected",
    );

    expect(await counts("labels", "lab-1")).toEqual({ certified: 0, renderable: 0 });
    expect(await readPublicProjectionMaintenanceSnapshot(db)).toEqual(before);
    const legacyMarkers = await db.execute(
      `select count(*) as n from due_work where work_kind = 'source-repair'`,
    );
    expect(Number(legacyMarkers.rows[0]?.n ?? -1)).toBe(0);
    expect(await tempHubCountTables()).toEqual([]);

    await db.execute(`drop trigger reject_label_hub_count_apply`);
    const recovered = await backfillHubCounts(db, { force: true });
    expect(recovered.filled).toEqual({ albums: 1, artists: 1, labels: 1 });
    expect(await tempHubCountTables()).toEqual([]);
  });
});
