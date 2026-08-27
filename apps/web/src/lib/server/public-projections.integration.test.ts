import { type Client, type InValue } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";
import { batchDueWorkSourceMutation } from "./due-work";
import {
  PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY,
  readProjectedAggregateBuckets,
  readProjectedDefaultTrackTotal,
  readProjectedTrackHubAnchors,
  readQualifiedArtistIds,
  type PublicProjectionReadClient,
} from "./public-projection-cutover";
import {
  artistQualificationLabelFanoutQuery,
  auditPublicProjections,
  markPublicLabelSourceChangedStatements,
  markPublicTrackSourceChangedStatements,
  publicTrackSourceVersion,
  rebuildDefaultTrackHubAnchors,
  rebuildPublicProjection,
  repairPublicAggregateTrack,
  repairPublicProjectionChunk,
  runPublicProjectionRebuildChunk,
  shadowPublicProjections,
  type PublicProjectionClient,
} from "./public-projections";
import {
  projectedTracksHubIdPageQueries,
  TRACKS_HUB_ANCHOR_ADDRESS,
  TRACKS_HUB_PAGE_SIZE,
} from "./tracks-hub";
import { QUALIFIED_ARTISTS_SQL } from "./catalogue";

const OLD = "2026-01-01T00:00:00.000Z";
const NOW = new Date("2026-01-10T12:00:00.000Z");

let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
});

afterEach(() => db.close());

async function seedLabel(id: string, enabled: boolean): Promise<void> {
  await db.execute({
    args: [id, id, id, enabled ? "enabled" : "disabled", OLD, OLD],
    sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?)`,
  });
}

async function seedArtist(id: string): Promise<void> {
  await db.execute({
    args: [id, id, id, OLD, OLD],
    sql: `insert into artists (id, name, slug, created_at, updated_at)
      values (?, ?, ?, ?, ?)`,
  });
}

async function seedProjectedTrack(options: {
  artistIds?: { id: string; role?: "remixer" }[];
  certified?: boolean;
  key: null | string;
  labelId?: null | string;
  releaseDate: null | string;
  trackId: string;
}): Promise<void> {
  if (options.certified) {
    await seedTrack(db, { logId: `001.1.${options.trackId.slice(-1)}`, trackId: options.trackId });
  } else {
    await seedCatalogueTrack(db, { trackId: options.trackId });
  }
  await db.execute({
    args: [options.releaseDate, options.key, options.labelId ?? null, options.trackId],
    sql: `update tracks set release_date = ?, key = ?, label_id = ? where track_id = ?`,
  });
  for (const [position, artist] of (options.artistIds ?? []).entries()) {
    await db.execute({
      args: [options.trackId, artist.id, position, artist.role ?? null],
      sql: `insert into track_artists (track_id, artist_id, position, role)
        values (?, ?, ?, ?)`,
    });
  }
}

async function seedProjectionWorld(): Promise<void> {
  await seedLabel("lane", true);
  await seedLabel("off", false);
  for (const artistId of ["primary", "remixer", "certified"]) {
    await seedArtist(artistId);
  }
  await seedProjectedTrack({
    artistIds: [{ id: "primary" }, { id: "remixer", role: "remixer" }],
    key: null,
    labelId: "lane",
    releaseDate: null,
    trackId: "track-null",
  });
  await seedProjectedTrack({
    artistIds: [{ id: "primary" }, { id: "remixer", role: "remixer" }],
    key: "",
    labelId: "lane",
    releaseDate: "",
    trackId: "track-empty",
  });
  await seedProjectedTrack({
    artistIds: [{ id: "primary" }, { id: "remixer", role: "remixer" }],
    key: "wat",
    labelId: "lane",
    releaseDate: "20x?long",
    trackId: "track-malformed",
  });
  await seedProjectedTrack({
    artistIds: [{ id: "certified" }],
    certified: true,
    key: "C minor",
    labelId: "off",
    releaseDate: "2024-06-01",
    trackId: "track-certified",
  });
}

async function rebuildAll(): Promise<void> {
  await rebuildPublicProjection(db, "public_aggregates", {
    generation: "aggregate-a",
    limit: 2,
  });
  await rebuildPublicProjection(db, "artist_qualification", {
    generation: "artists-a",
    limit: 2,
  });
  await rebuildDefaultTrackHubAnchors(db, { generation: "aggregate-a", now: () => NOW });
}

async function setCutover(value: string): Promise<void> {
  await db.execute({
    args: [PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY, value],
    sql: `insert into settings (key, value) values (?, ?)
      on conflict(key) do update set value = excluded.value`,
  });
}

async function drainRepairs(limit = 2): Promise<void> {
  for (let pass = 0; pass < 100; pass += 1) {
    const pending = Number(
      (await db.execute(`select count(*) as n from projection_repairs`)).rows[0]?.n ?? 0,
    );
    if (pending === 0) {
      return;
    }
    await repairPublicProjectionChunk(db, { limit, now: () => NOW });
  }
  throw new Error("public projection repairs did not drain");
}

describe("public shadow projections", () => {
  it("seeks projected hub pages through composite ranges, including the NULL transition", async () => {
    await seedProjectedTrack({
      key: null,
      releaseDate: "2026-01-01",
      trackId: "track-newer",
    });
    await seedProjectedTrack({
      key: null,
      releaseDate: "2024-01-01",
      trackId: "track-dated",
    });
    await seedProjectedTrack({ key: null, releaseDate: null, trackId: "track-null-a" });
    await seedProjectedTrack({ key: null, releaseDate: null, trackId: "track-null-z" });

    const transition = projectedTracksHubIdPageQueries(
      2,
      [{ id: "track-z", key: "2025-01-01", page: 2 }],
      3,
    );
    expect(transition.primary.args).toEqual(["2025-01-01", "track-z", 3]);
    expect(transition.primary.sql).toContain(
      "where (tracks.release_date, tracks.track_id) < (?, ?)",
    );
    const primary = await db.execute(transition.primary);
    const fill = await db.execute(transition.nullFill?.(3 - primary.rows.length) ?? "select 0");
    expect([...primary.rows, ...fill.rows].map((row) => row.track_id)).toEqual([
      "track-dated",
      "track-null-z",
      "track-null-a",
    ]);

    const nullZone = projectedTracksHubIdPageQueries(
      2,
      [{ id: "track-null-z", key: null, page: 2 }],
      3,
    );
    expect((await db.execute(nullZone.primary)).rows.map((row) => row.track_id)).toEqual([
      "track-null-a",
    ]);

    const plans = [transition.primary, transition.nullFill?.(2), nullZone.primary];
    for (const query of plans) {
      expect(query).toBeDefined();
      if (query === undefined) {
        continue;
      }
      const details = (
        await db.execute({ args: query.args, sql: `explain query plan ${query.sql}` })
      ).rows
        .map((row) => (typeof row.detail === "string" ? row.detail : ""))
        .join("\n");
      expect(details).toContain("tracks_release_date_track_id_idx");
      expect(details).toContain("SEARCH tracks");
      expect(details).not.toContain("SCAN tracks");
      expect(details).not.toContain("USE TEMP B-TREE");
      if (query === transition.primary) {
        expect(details).toMatch(/\(\(release_date,track_id\)<\(\?,\?\)\)/);
      }
    }
  });

  it("seeks through a large same-date tie on both composite columns", async () => {
    const tieSize = 192;
    for (let index = 0; index < tieSize; index += 1) {
      await seedProjectedTrack({
        key: null,
        releaseDate: "2024-01-01",
        trackId: `track-tie-${String(index).padStart(3, "0")}`,
      });
    }

    const anchorId = "track-tie-128";
    const query = projectedTracksHubIdPageQueries(
      2,
      [{ id: anchorId, key: "2024-01-01", page: 2 }],
      48,
    ).primary;
    const rows = await db.execute(query);

    expect(rows.rows.map((row) => row.track_id)).toEqual(
      Array.from(
        { length: 48 },
        (_value, offset) => `track-tie-${String(127 - offset).padStart(3, "0")}`,
      ),
    );

    const details = (
      await db.execute({ args: query.args, sql: `explain query plan ${query.sql}` })
    ).rows
      .map((row) => (typeof row.detail === "string" ? row.detail : ""))
      .join("\n");
    expect(details).toMatch(
      /SEARCH tracks USING COVERING INDEX tracks_release_date_track_id_idx \(\(release_date,track_id\)<\(\?,\?\)\)/,
    );
    expect(details).not.toContain("USE TEMP B-TREE");
  });

  it("keeps absent, false, malformed, and unreadable flags closed and opens only literal true", async () => {
    await seedProjectionWorld();
    await rebuildAll();

    expect(await readProjectedDefaultTrackTotal(db)).toBeUndefined();
    await setCutover("false");
    expect(await readProjectedDefaultTrackTotal(db)).toBeUndefined();
    await setCutover("TRUE");
    expect(await readProjectedDefaultTrackTotal(db)).toBeUndefined();
    await setCutover("true");
    expect(await readProjectedDefaultTrackTotal(db)).toBe(4);

    const unreadable: PublicProjectionReadClient = {
      execute: async (statement) => {
        const sql = typeof statement === "string" ? statement : statement.sql;
        if (sql.includes("from settings")) {
          throw new Error("settings unavailable");
        }
        return db.execute(statement);
      },
    };
    expect(await readProjectedDefaultTrackTotal(unreadable)).toBeUndefined();
  });

  it("gates aggregates, artists, and anchors independently on exact readiness", async () => {
    await seedProjectionWorld();
    await rebuildAll();
    await setCutover("true");

    expect(await readProjectedDefaultTrackTotal(db)).toBe(4);
    expect(await readQualifiedArtistIds(db, QUALIFIED_ARTISTS_SQL)).toEqual([
      "certified",
      "primary",
    ]);
    expect(
      await readProjectedTrackHubAnchors(db, TRACKS_HUB_ANCHOR_ADDRESS, TRACKS_HUB_PAGE_SIZE),
    ).toEqual({ anchors: [], total: 4 });

    await db.execute(`update artist_qualification_state
      set state = 'running', completed_at = null, source_digest = null, projected_digest = null
      where scope = 'artists'`);
    await db.execute(`delete from artist_qualification where artist_id = 'primary'`);
    expect(await readProjectedDefaultTrackTotal(db)).toBe(4);
    expect(await readQualifiedArtistIds(db, QUALIFIED_ARTISTS_SQL)).toEqual([
      "certified",
      "primary",
    ]);

    await db.execute(`update artist_qualification_state
      set state = 'complete', completed_at = '${OLD}', source_digest = 'source',
          projected_digest = 'projection'
      where scope = 'artists'`);
    await db.execute(`insert into projection_repairs
      (projection, subject_type, subject_id, source_epoch, source_version, created_at, updated_at)
      values ('artist_qualification', 'artist', 'primary', 1, 'repair', '${OLD}', '${OLD}')`);
    expect(await readQualifiedArtistIds(db, QUALIFIED_ARTISTS_SQL)).toEqual([
      "certified",
      "primary",
    ]);
    await db.execute(`delete from projection_repairs where projection = 'artist_qualification'`);
    await db.execute(`update public_aggregate_state
      set source_epoch = aggregate_epoch + 1, default_track_total = 99
      where scope = 'tracks'`);
    expect(await readProjectedDefaultTrackTotal(db)).toBeUndefined();
    expect(await readQualifiedArtistIds(db, QUALIFIED_ARTISTS_SQL)).toEqual(["certified"]);
  });

  it("falls back on running, epoch-stale, repair-marked, and malformed-anchor states", async () => {
    await seedProjectionWorld();
    await rebuildAll();
    await setCutover("true");

    await db.execute(`update public_aggregate_state
      set state = 'running', completed_at = null, source_digest = null, projected_digest = null
      where scope = 'tracks'`);
    expect(await readProjectedDefaultTrackTotal(db)).toBeUndefined();

    await db.execute(`update public_aggregate_state
      set state = 'complete', completed_at = '${OLD}', source_digest = 'source',
          projected_digest = 'projection', source_epoch = aggregate_epoch + 1
      where scope = 'tracks'`);
    expect(await readProjectedDefaultTrackTotal(db)).toBeUndefined();

    await db.execute(`update public_aggregate_state set aggregate_epoch = source_epoch
      where scope = 'tracks'`);
    await db.execute(`insert into projection_repairs
      (projection, subject_type, subject_id, source_epoch, source_version, created_at, updated_at)
      values ('public_aggregates', 'track', 'track-null', 1, 'repair', '${OLD}', '${OLD}')`);
    expect(await readProjectedDefaultTrackTotal(db)).toBeUndefined();

    await db.execute(`delete from projection_repairs where projection = 'public_aggregates'`);
    await db.execute({
      args: [TRACKS_HUB_ANCHOR_ADDRESS.hub, TRACKS_HUB_ANCHOR_ADDRESS.clauseHash],
      sql: `delete from hub_page_anchor_validity where hub = ? and clause_hash = ?`,
    });
    expect(
      await readProjectedTrackHubAnchors(db, TRACKS_HUB_ANCHOR_ADDRESS, TRACKS_HUB_PAGE_SIZE),
    ).toBeUndefined();

    await rebuildDefaultTrackHubAnchors(db, { generation: "aggregate-a", now: () => NOW });
    await db.execute({
      args: [TRACKS_HUB_ANCHOR_ADDRESS.hub, TRACKS_HUB_ANCHOR_ADDRESS.clauseHash],
      sql: `update hub_page_anchor_validity
        set anchor_format_version = anchor_format_version + 1
        where hub = ? and clause_hash = ?`,
    });
    expect(
      await readProjectedTrackHubAnchors(db, TRACKS_HUB_ANCHOR_ADDRESS, TRACKS_HUB_PAGE_SIZE),
    ).toBeUndefined();

    await rebuildDefaultTrackHubAnchors(db, { generation: "aggregate-a", now: () => NOW });
    await db.execute({
      args: [TRACKS_HUB_ANCHOR_ADDRESS.hub, TRACKS_HUB_ANCHOR_ADDRESS.clauseHash],
      sql: `update hub_page_anchor_validity set order_epoch = order_epoch + 1
        where hub = ? and clause_hash = ?`,
    });
    expect(
      await readProjectedTrackHubAnchors(db, TRACKS_HUB_ANCHOR_ADDRESS, TRACKS_HUB_PAGE_SIZE),
    ).toBeUndefined();

    await rebuildDefaultTrackHubAnchors(db, { generation: "aggregate-a", now: () => NOW });
    await db.execute({
      args: [TRACKS_HUB_ANCHOR_ADDRESS.hub, TRACKS_HUB_ANCHOR_ADDRESS.clauseHash],
      sql: `update hub_page_anchor_validity set generation = 'other'
        where hub = ? and clause_hash = ?`,
    });
    expect(
      await readProjectedTrackHubAnchors(db, TRACKS_HUB_ANCHOR_ADDRESS, TRACKS_HUB_PAGE_SIZE),
    ).toBeUndefined();

    await rebuildDefaultTrackHubAnchors(db, { generation: "aggregate-a", now: () => NOW });
    await db.execute({
      args: [TRACKS_HUB_ANCHOR_ADDRESS.hub, TRACKS_HUB_ANCHOR_ADDRESS.clauseHash],
      sql: `update hub_page_anchors set anchors_json = '{bad json'
        where hub = ? and clause_hash = ?`,
    });
    expect(await readProjectedDefaultTrackTotal(db)).toBe(4);
    expect(
      await readProjectedTrackHubAnchors(db, TRACKS_HUB_ANCHOR_ADDRESS, TRACKS_HUB_PAGE_SIZE),
    ).toBeUndefined();
  });

  it("reads literal year/key buckets and projection indexes without a source scan or temp sort", async () => {
    await seedProjectionWorld();
    await rebuildAll();
    await setCutover("true");

    expect(await readProjectedAggregateBuckets(db, "release_date_bucket")).toEqual([
      { bucket: "20x?", count: 1 },
      { bucket: "2024", count: 1 },
      { bucket: "", count: 1 },
    ]);
    expect(await readProjectedAggregateBuckets(db, "key")).toEqual([
      { bucket: "", count: 1 },
      { bucket: "C minor", count: 1 },
      { bucket: "wat", count: 1 },
    ]);

    const statements: Array<{ args: InValue[]; sql: string }> = [];
    const traced: PublicProjectionReadClient = {
      execute: async (statement) => {
        const normalized = {
          args:
            typeof statement !== "string" && Array.isArray(statement.args)
              ? (statement.args as InValue[])
              : [],
          sql: typeof statement === "string" ? statement : statement.sql,
        };
        statements.push(normalized);
        return db.execute(statement);
      },
    };
    await readProjectedAggregateBuckets(traced, "key");
    await readQualifiedArtistIds(traced, QUALIFIED_ARTISTS_SQL);
    await readProjectedTrackHubAnchors(traced, TRACKS_HUB_ANCHOR_ADDRESS, TRACKS_HUB_PAGE_SIZE);

    for (const statement of statements.filter(
      ({ sql }) => !sql.includes("from settings") && !sql.includes("select artist_id from ("),
    )) {
      const plan = await db.execute({
        args: statement.args,
        sql: `explain query plan ${statement.sql}`,
      });
      const details = plan.rows
        .map((row) => (typeof row.detail === "string" ? row.detail : ""))
        .join("\n");
      expect(details).not.toContain("SCAN tracks");
      expect(details).not.toContain("SCAN track_artists");
      expect(details).not.toContain("USE TEMP B-TREE");
    }
    expect(statements.map(({ sql }) => sql).join("\n")).toContain(
      "artist_qualification_qualified_idx",
    );
  });

  it("rebuilds literal buckets, exact weighted qualification, totals, anchors, and shadow equivalence", async () => {
    await seedProjectionWorld();
    await rebuildAll();

    expect(
      (
        await db.execute(`select aggregate_kind, bucket, track_count
        from public_aggregate_counts order by aggregate_kind, bucket`)
      ).rows,
    ).toEqual([
      { aggregate_kind: "key", bucket: "", track_count: 1 },
      { aggregate_kind: "key", bucket: "C minor", track_count: 1 },
      { aggregate_kind: "key", bucket: "wat", track_count: 1 },
      { aggregate_kind: "release_date_bucket", bucket: "", track_count: 1 },
      { aggregate_kind: "release_date_bucket", bucket: "2024", track_count: 1 },
      { aggregate_kind: "release_date_bucket", bucket: "20x?", track_count: 1 },
    ]);
    expect(
      (
        await db.execute(`select track_id, release_date_bucket, key_bucket
        from public_aggregate_membership order by track_id`)
      ).rows,
    ).toEqual([
      { key_bucket: "C minor", release_date_bucket: "2024", track_id: "track-certified" },
      { key_bucket: "", release_date_bucket: "", track_id: "track-empty" },
      { key_bucket: "wat", release_date_bucket: "20x?", track_id: "track-malformed" },
      { key_bucket: null, release_date_bucket: null, track_id: "track-null" },
    ]);
    expect(
      (
        await db.execute(`select artist_id, certified_finding_count,
          enabled_credit_half_units, is_qualified
        from artist_qualification order by artist_id`)
      ).rows,
    ).toEqual([
      {
        artist_id: "certified",
        certified_finding_count: 1,
        enabled_credit_half_units: 0,
        is_qualified: 1,
      },
      {
        artist_id: "primary",
        certified_finding_count: 0,
        enabled_credit_half_units: 6,
        is_qualified: 1,
      },
      {
        artist_id: "remixer",
        certified_finding_count: 0,
        enabled_credit_half_units: 3,
        is_qualified: 0,
      },
    ]);
    const shadow = await shadowPublicProjections(db);
    expect(shadow).toMatchObject({
      aggregateBucketsMatched: true,
      anchorEpochMatched: true,
      anchorOrderMatched: true,
      defaultTotalMatched: true,
      matched: true,
    });
  });

  it("applies exact old-to-new track deltas and preserves a newer concurrent marker", async () => {
    await seedProjectionWorld();
    await rebuildAll();
    const initialOrderEpoch = Number(
      (
        await db.execute(`select release_hub_order_epoch as epoch
          from public_aggregate_state where scope = 'tracks'`)
      ).rows[0]?.epoch,
    );
    const newVersion = publicTrackSourceVersion({ key: "D minor", releaseDate: "2025-02-01" });
    await db.batch(
      [
        {
          args: [],
          sql: `update tracks set release_date = '2025-02-01', key = 'D minor'
            where track_id = 'track-empty'`,
        },
        ...markPublicTrackSourceChangedStatements("track-empty", newVersion, {
          now: NOW,
        }),
      ],
      "write",
    );
    await drainRepairs();
    const invalidatedOrderEpoch = Number(
      (
        await db.execute(`select release_hub_order_epoch as epoch
          from public_aggregate_state where scope = 'tracks'`)
      ).rows[0]?.epoch,
    );
    expect(invalidatedOrderEpoch).toBe(initialOrderEpoch + 1);
    expect(
      (
        await db.execute(`select order_epoch from hub_page_anchor_validity
          where hub = 'tracks'`)
      ).rows[0]?.order_epoch,
    ).toBe(initialOrderEpoch);
    expect(await shadowPublicProjections(db)).toMatchObject({
      anchorEpochMatched: false,
      anchorOrderMatched: true,
      matched: false,
    });
    expect(
      (
        await db.execute(`select aggregate_kind, bucket, track_count
        from public_aggregate_counts
        where bucket in ('', '2025', 'D minor') order by aggregate_kind, bucket`)
      ).rows,
    ).toEqual([
      { aggregate_kind: "key", bucket: "D minor", track_count: 1 },
      { aggregate_kind: "release_date_bucket", bucket: "2025", track_count: 1 },
    ]);

    await db.batch(
      [
        { args: [], sql: `update tracks set key = 'E minor' where track_id = 'track-empty'` },
        ...markPublicTrackSourceChangedStatements("track-empty", "marker-old", { now: NOW }),
      ],
      "write",
    );
    let intercepted = false;
    const racingClient: PublicProjectionClient = {
      batch: async (statements, mode) => {
        if (!intercepted) {
          intercepted = true;
          await db.execute({
            args: [],
            sql: `update projection_repairs
              set source_epoch = source_epoch + 1, source_version = 'marker-new'
              where projection = 'public_aggregates' and subject_type = 'track'
                and subject_id = 'track-empty'`,
          });
        }
        return db.batch(statements, mode);
      },
      execute: db.execute.bind(db),
    };
    expect(await repairPublicAggregateTrack(racingClient, "track-empty", { now: () => NOW })).toBe(
      false,
    );
    expect(
      (
        await db.execute(`select source_version from projection_repairs
        where projection = 'public_aggregates' and subject_id = 'track-empty'`)
      ).rows[0]?.source_version,
    ).toBe("marker-new");
    expect(
      (
        await db.execute(`select release_hub_order_epoch as epoch
          from public_aggregate_state where scope = 'tracks'`)
      ).rows[0]?.epoch,
    ).toBe(invalidatedOrderEpoch);
  });

  it("fans label changes through an indexed bounded track page and updates remixer weights", async () => {
    await seedProjectionWorld();
    await rebuildAll();
    const plan = await db.execute({
      args: artistQualificationLabelFanoutQuery("lane", 1, 2).args,
      sql: `explain query plan ${artistQualificationLabelFanoutQuery("lane", 1, 2).sql}`,
    });
    const details = (plan.rows as unknown as { detail: string }[])
      .map((row) => row.detail)
      .join("\n");
    expect(details).toContain("tracks_label_id_idx");
    expect(details).not.toContain("SCAN t");
    expect(details).not.toContain("USE TEMP B-TREE");

    await db.batch(
      [
        { args: [], sql: `update labels set seed_state = 'disabled' where id = 'lane'` },
        ...markPublicLabelSourceChangedStatements("lane", "label-disabled", { now: NOW }),
      ],
      "write",
    );
    await drainRepairs(1);
    expect(
      (
        await db.execute(`select artist_id, enabled_credit_half_units, is_qualified
        from artist_qualification order by artist_id`)
      ).rows,
    ).toEqual([{ artist_id: "certified", enabled_credit_half_units: 0, is_qualified: 1 }]);
  });

  it("converges after representative track, finding, edge, and label source transactions", async () => {
    await seedProjectionWorld();
    await rebuildAll();

    await batchDueWorkSourceMutation(
      db,
      [{ args: [], sql: `update tracks set key = 'F minor' where track_id = 'track-empty'` }],
      [{ subjectId: "track-empty", subjectType: "track" }],
      { markerVersion: "track-write", now: NOW, producer: "test-track-writer" },
    );
    await batchDueWorkSourceMutation(
      db,
      [{ args: [], sql: `delete from findings where track_id = 'track-certified'` }],
      [{ subjectId: "track-certified", subjectType: "track" }],
      { markerVersion: "finding-write", now: NOW, producer: "test-finding-writer" },
    );
    await batchDueWorkSourceMutation(
      db,
      [
        {
          args: [],
          sql: `update track_artists set role = 'remixer'
                where track_id = 'track-null' and artist_id = 'primary'`,
        },
      ],
      [{ subjectId: "track-null", subjectType: "track" }],
      { markerVersion: "edge-write", now: NOW, producer: "test-edge-writer" },
    );
    await batchDueWorkSourceMutation(
      db,
      [{ args: [], sql: `update labels set seed_state = 'disabled' where id = 'lane'` }],
      [{ subjectId: "lane", subjectType: "label" }],
      { markerVersion: "label-write", now: NOW, producer: "test-label-writer" },
    );

    await drainRepairs(1);
    await rebuildDefaultTrackHubAnchors(db, { generation: "anchors-b", now: () => NOW });
    expect(await shadowPublicProjections(db)).toMatchObject({ matched: true });
  });

  it("resumes sorted generations, preserves live rows, detects drift, and converges in bounded passes", async () => {
    await seedProjectionWorld();
    await rebuildAll();
    const first = await runPublicProjectionRebuildChunk(db, "public_aggregates", {
      generation: "aggregate-resume",
      limit: 2,
      newGeneration: true,
      now: () => new Date("2026-01-10T00:00:00.000Z"),
    });
    expect(first.complete).toBe(false);
    expect(first.checkpoint.cursor).toBe("track-empty");

    await db.batch(
      [
        {
          args: [],
          sql: `update tracks set key = 'Live key' where track_id = 'track-null'`,
        },
        ...markPublicTrackSourceChangedStatements(
          "track-null",
          publicTrackSourceVersion({ key: "Live key", releaseDate: null }),
          { now: "2026-01-10T01:00:00.000Z" },
        ),
      ],
      "write",
    );
    await drainRepairs();
    await rebuildPublicProjection(db, "public_aggregates", { limit: 2 });
    expect(
      (
        await db.execute(`select generation, key_bucket from public_aggregate_membership
        where track_id = 'track-null'`)
      ).rows[0],
    ).toEqual({ generation: "live", key_bucket: "Live key" });

    await db.execute(`update public_aggregate_membership
      set release_date_bucket = 'oops' where track_id = 'track-malformed'`);
    await db.execute(`update public_aggregate_counts set track_count = track_count + 7
      where aggregate_kind = 'key' and bucket = 'wat'`);
    await db.execute(`update artist_qualification
      set certified_finding_count = 2 where artist_id = 'certified'`);

    for (let pass = 0; pass < 6; pass += 1) {
      const audit = await auditPublicProjections(db, { repairLimit: 2 });
      if (audit.aggregatesMatched && audit.artistMatched) {
        break;
      }
      await drainRepairs(2);
    }
    const finalAudit = await auditPublicProjections(db);
    expect(finalAudit.aggregatesMatched).toBe(true);
    expect(finalAudit.artistMatched).toBe(true);
    expect(
      (
        await db.execute(`select audited_at, source_digest = projected_digest as digests_match
          from public_aggregate_state where scope = 'tracks'`)
      ).rows[0],
    ).toMatchObject({ audited_at: expect.any(String), digests_match: 1 });
    expect(
      (
        await db.execute(`select audited_at, source_digest = projected_digest as digests_match
          from artist_qualification_state where scope = 'artists'`)
      ).rows[0],
    ).toMatchObject({ audited_at: expect.any(String), digests_match: 1 });
  });
});
