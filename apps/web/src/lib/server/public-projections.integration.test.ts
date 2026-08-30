import { type Client, type InValue } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";
import { batchDueWorkSourceMutation } from "./due-work";
import { markPublicProjectionSourceChangedStatements } from "./public-projection-source-maintenance";
import {
  PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY,
  readProjectedAggregateBuckets,
  readProjectedDefaultTrackTotal,
  readProjectedTrackHubAnchors,
  readQualifiedArtistIds,
  type PublicProjectionReadClient,
} from "./public-projection-cutover";
import {
  PUBLIC_PROJECTION_WRITE_STATEMENT_LIMIT,
  PUBLIC_PROJECTION_WRITE_SUBPAGE_SIZE,
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

async function seedBulkProjectionWorld(total = 501): Promise<void> {
  await seedLabel("bulk-lane", true);
  await seedArtist("bulk-primary");
  await seedArtist("bulk-secondary");
  await db.execute({
    args: [total - 1, JSON.stringify(["Bulk Artist"])],
    sql: `with recursive source(n) as (
        select 0 union all select n + 1 from source where n < ?
      )
      insert into tracks
        (track_id, title, artists_json, spotify_uri, spotify_url, duration_ms, label_id,
         release_date, key)
      select printf('bulk-%03d', n), printf('Bulk Track %03d', n), ?,
        'spotify:track:' || printf('bulk-%03d', n),
        'https://example.invalid/' || printf('bulk-%03d', n), 270000, 'bulk-lane',
        case when n % 11 = 0 then null when n % 7 = 0 then ''
          else printf('%04d-01-01', 2000 + n % 27) end,
        case when n % 13 = 0 then null when n % 5 = 0 then ''
          else case n % 3 when 0 then 'Am' when 1 then 'Dm' else 'F#m' end end
      from source`,
  });
  await db.execute(`insert into track_artists (track_id, artist_id, position, role)
    select track_id, 'bulk-primary', 1,
      case when cast(substr(track_id, 6) as integer) % 7 = 0 then 'remixer' else null end
    from tracks where track_id >= 'bulk-' and track_id < 'bulk.'`);
  await db.execute(`insert into track_artists (track_id, artist_id, position, role)
    select track_id, 'bulk-secondary', 2, null from tracks
    where track_id >= 'bulk-' and track_id < 'bulk.'
      and cast(substr(track_id, 6) as integer) % 10 = 0`);
  await db.execute({
    args: [OLD],
    sql: `insert into findings
      (track_id, log_id, added_at, added_to_spotify, posted_to_telegram)
      values ('bulk-000', '999.9.9', ?, 0, 0)`,
  });
}

async function seedHighCreditTracks(trackIds: readonly string[], creditsPerTrack: number) {
  await seedLabel("credit-lane", true);
  await db.execute({
    args: [creditsPerTrack - 1, OLD, OLD],
    sql: `with recursive source(n) as (
        select 0 union all select n + 1 from source where n < ?
      )
      insert into artists (id, name, slug, created_at, updated_at)
      select printf('credit-%03d', n), printf('Credit Artist %03d', n),
        printf('credit-artist-%03d', n), ?, ? from source`,
  });
  for (const trackId of trackIds) {
    await seedCatalogueTrack(db, { trackId });
    await db.execute({
      args: [trackId],
      sql: `update tracks set label_id = 'credit-lane' where track_id = ?`,
    });
    await db.execute({
      args: [trackId],
      sql: `insert into track_artists (track_id, artist_id, position)
        select ?, id, cast(substr(id, 8) as integer) + 1
        from artists where id >= 'credit-' and id < 'credit.' order by id`,
    });
  }
}

function projectionClientProbe(options: { failWriteSubpage?: number } = {}) {
  const evidence = {
    batchCalls: 0,
    executeCalls: 0,
    executeSql: [] as string[],
    maximumBatchStatements: 0,
    writeSubpages: 0,
  };
  let failurePending = options.failWriteSubpage !== undefined;
  const client: PublicProjectionClient = {
    batch: async (statements, mode) => {
      evidence.batchCalls += 1;
      evidence.maximumBatchStatements = Math.max(
        evidence.maximumBatchStatements,
        statements.length,
      );
      const writeSubpage = statements.some((statement) => {
        const sql =
          typeof statement === "string"
            ? statement
            : Array.isArray(statement)
              ? statement[0]
              : statement.sql;
        return (
          sql.includes("delete from public_aggregate_membership") ||
          sql.includes("delete from artist_qualification_contributions")
        );
      });
      if (writeSubpage) {
        evidence.writeSubpages += 1;
        if (failurePending && evidence.writeSubpages === options.failWriteSubpage) {
          failurePending = false;
          throw new Error("injected projection write-subpage failure");
        }
      }
      return db.batch(statements, mode);
    },
    execute: async (statement) => {
      evidence.executeCalls += 1;
      evidence.executeSql.push(
        typeof statement === "string"
          ? statement
          : Array.isArray(statement)
            ? statement[0]
            : statement.sql,
      );
      return db.execute(statement);
    },
  };
  return { client, evidence };
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
      {
        markerVersion: "track-write",
        now: NOW,
        producer: "track-update",
        publicProjectionImpact: {
          impact: "public_aggregates",
          justification: "The test mutation writes tracks.key.",
        },
      },
    );
    await batchDueWorkSourceMutation(
      db,
      [{ args: [], sql: `delete from findings where track_id = 'track-certified'` }],
      [{ subjectId: "track-certified", subjectType: "track" }],
      { markerVersion: "finding-write", now: NOW, producer: "certify-track" },
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
      { markerVersion: "edge-write", now: NOW, producer: "artist-remixer-role-stamp" },
    );
    await batchDueWorkSourceMutation(
      db,
      [{ args: [], sql: `update labels set seed_state = 'disabled' where id = 'lane'` }],
      [{ subjectId: "lane", subjectType: "label" }],
      {
        markerVersion: "label-write",
        now: NOW,
        producer: "label-seed-state",
        publicProjectionImpact: {
          impact: "artist_qualification",
          justification: "The test mutation writes labels.seed_state.",
        },
      },
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

  it("preserves an aggregate live repair that lands in the bulk read-to-batch gap", async () => {
    await seedProjectedTrack({
      key: "A minor",
      releaseDate: "2024-01-01",
      trackId: "aggregate-gap",
    });
    await rebuildPublicProjection(db, "public_aggregates", {
      generation: "aggregate-gap-base",
      limit: 1,
      now: () => new Date(OLD),
    });

    let intercepted = false;
    const racingClient: PublicProjectionClient = {
      batch: async (statements, mode) => {
        const isRebuildWrite = statements.some((statement) => {
          const sql =
            typeof statement === "string"
              ? statement
              : Array.isArray(statement)
                ? statement[0]
                : statement.sql;
          return sql.includes("delete from public_aggregate_membership");
        });
        if (!intercepted && isRebuildWrite) {
          intercepted = true;
          const liveAt = "2026-01-10T00:00:00.000Z";
          await db.batch(
            [
              {
                args: [],
                sql: `update tracks set key = 'B minor' where track_id = 'aggregate-gap'`,
              },
              ...markPublicTrackSourceChangedStatements(
                "aggregate-gap",
                publicTrackSourceVersion({ key: "B minor", releaseDate: "2024-01-01" }),
                { now: liveAt },
              ),
            ],
            "write",
          );
          expect(
            await repairPublicAggregateTrack(db, "aggregate-gap", {
              now: () => new Date(liveAt),
            }),
          ).toBe(true);
        }
        return db.batch(statements, mode);
      },
      execute: db.execute.bind(db),
    };

    await expect(
      runPublicProjectionRebuildChunk(racingClient, "public_aggregates", {
        boundedCleanup: true,
        generation: "aggregate-gap-rebuild",
        limit: 1,
        newGeneration: true,
        now: () => new Date("2026-01-10T00:00:00.000Z"),
      }),
    ).rejects.toThrow("public_aggregates source epoch changed during rebuild page; retry required");
    expect(intercepted).toBe(true);
    expect(
      (await db.execute(`select cursor from public_aggregate_state where scope = 'tracks'`)).rows[0]
        ?.cursor,
    ).toBeNull();
    const rebuilt = await runPublicProjectionRebuildChunk(db, "public_aggregates", {
      boundedCleanup: true,
      generation: "aggregate-gap-rebuild",
      limit: 1,
      now: () => new Date("2026-01-10T00:00:00.000Z"),
    });
    expect(rebuilt.checkpoint.cursor).toBe("aggregate-gap");
    expect(
      (
        await db.execute(`select generation, key_bucket, updated_at
          from public_aggregate_membership where track_id = 'aggregate-gap'`)
      ).rows[0],
    ).toEqual({
      generation: "live",
      key_bucket: "B minor",
      updated_at: "2026-01-10T00:00:00.000Z",
    });
    expect(
      (
        await db.execute(`select bucket, track_count from public_aggregate_counts
          where aggregate_kind = 'key' order by bucket`)
      ).rows,
    ).toEqual([{ bucket: "B minor", track_count: 1 }]);
  });

  it("preserves an artist live repair that lands in the bulk read-to-batch gap", async () => {
    await seedLabel("artist-gap-lane", true);
    await seedArtist("artist-gap-credit");
    await seedProjectedTrack({
      artistIds: [{ id: "artist-gap-credit" }],
      key: null,
      labelId: "artist-gap-lane",
      releaseDate: null,
      trackId: "artist-gap",
    });
    await rebuildPublicProjection(db, "artist_qualification", {
      generation: "artist-gap-base",
      limit: 1,
      now: () => new Date(OLD),
    });

    let intercepted = false;
    const racingClient: PublicProjectionClient = {
      batch: async (statements, mode) => {
        const isRebuildWrite = statements.some((statement) => {
          const sql =
            typeof statement === "string"
              ? statement
              : Array.isArray(statement)
                ? statement[0]
                : statement.sql;
          return sql.includes("delete from artist_qualification_contributions");
        });
        if (!intercepted && isRebuildWrite) {
          intercepted = true;
          const liveAt = "2026-01-10T00:00:00.000Z";
          await db.batch(
            [
              {
                args: [],
                sql: `update track_artists set role = 'remixer'
                  where track_id = 'artist-gap' and artist_id = 'artist-gap-credit'`,
              },
              ...markPublicProjectionSourceChangedStatements(
                [{ subjectId: "artist-gap", subjectType: "track" }],
                "artist-gap-live",
                ["artist_qualification"],
                { now: liveAt },
              ),
            ],
            "write",
          );
          expect(
            await repairPublicProjectionChunk(db, {
              limit: 1,
              now: () => new Date(liveAt),
              projection: "artist_qualification",
            }),
          ).toEqual({ fanout: 0, repaired: 1 });
        }
        return db.batch(statements, mode);
      },
      execute: db.execute.bind(db),
    };

    await expect(
      runPublicProjectionRebuildChunk(racingClient, "artist_qualification", {
        boundedCleanup: true,
        generation: "artist-gap-rebuild",
        limit: 1,
        newGeneration: true,
        now: () => new Date("2026-01-10T00:00:00.000Z"),
      }),
    ).rejects.toThrow(
      "artist_qualification source epoch changed during rebuild page; retry required",
    );
    expect(intercepted).toBe(true);
    expect(
      (await db.execute(`select cursor from artist_qualification_state where scope = 'artists'`))
        .rows[0]?.cursor,
    ).toBeNull();
    const rebuilt = await runPublicProjectionRebuildChunk(db, "artist_qualification", {
      boundedCleanup: true,
      generation: "artist-gap-rebuild",
      limit: 1,
      now: () => new Date("2026-01-10T00:00:00.000Z"),
    });
    expect(rebuilt.checkpoint.cursor).toBe("artist-gap");
    expect(
      (
        await db.execute(`select generation, enabled_credit_half_units, updated_at
          from artist_qualification_contributions
          where track_id = 'artist-gap' and artist_id = 'artist-gap-credit'`)
      ).rows[0],
    ).toEqual({
      enabled_credit_half_units: 1,
      generation: "live",
      updated_at: "2026-01-10T00:00:00.000Z",
    });
    expect(
      (
        await db.execute(`select enabled_credit_half_units from artist_qualification
          where artist_id = 'artist-gap-credit'`)
      ).rows[0]?.enabled_credit_half_units,
    ).toBe(1);
  });

  it("preserves an aggregate deletion repair that leaves no live membership tombstone", async () => {
    await seedProjectedTrack({
      key: "C minor",
      releaseDate: "2023-01-01",
      trackId: "aggregate-delete-gap",
    });
    await rebuildPublicProjection(db, "public_aggregates", {
      generation: "aggregate-delete-base",
      limit: 1,
      now: () => new Date(OLD),
    });

    let intercepted = false;
    const racingClient: PublicProjectionClient = {
      batch: async (statements, mode) => {
        const isRebuildWrite = statements.some((statement) => {
          const sql =
            typeof statement === "string"
              ? statement
              : Array.isArray(statement)
                ? statement[0]
                : statement.sql;
          return sql.includes("delete from public_aggregate_membership");
        });
        if (!intercepted && isRebuildWrite) {
          intercepted = true;
          await db.batch(
            [
              { args: [], sql: `delete from tracks where track_id = 'aggregate-delete-gap'` },
              ...markPublicTrackSourceChangedStatements(
                "aggregate-delete-gap",
                "aggregate-deleted",
                { now: "2026-01-10T00:00:00.000Z" },
              ),
            ],
            "write",
          );
          expect(
            await repairPublicAggregateTrack(db, "aggregate-delete-gap", {
              now: () => new Date("2026-01-10T00:00:00.000Z"),
            }),
          ).toBe(true);
        }
        return db.batch(statements, mode);
      },
      execute: db.execute.bind(db),
    };

    await expect(
      runPublicProjectionRebuildChunk(racingClient, "public_aggregates", {
        boundedCleanup: true,
        generation: "aggregate-delete-rebuild",
        limit: 1,
        newGeneration: true,
        now: () => new Date("2026-01-10T00:00:00.000Z"),
      }),
    ).rejects.toThrow("public_aggregates source epoch changed during rebuild page; retry required");
    expect(intercepted).toBe(true);
    expect(
      Number(
        (
          await db.execute(`select count(*) as n from public_aggregate_membership
            where track_id = 'aggregate-delete-gap'`)
        ).rows[0]?.n,
      ),
    ).toBe(0);
    expect(
      Number((await db.execute(`select count(*) as n from public_aggregate_counts`)).rows[0]?.n),
    ).toBe(0);
    expect(
      (await db.execute(`select cursor from public_aggregate_state where scope = 'tracks'`)).rows[0]
        ?.cursor,
    ).toBeNull();
  });

  it("preserves an all-edges deletion repair that leaves no live contribution tombstone", async () => {
    await seedLabel("artist-delete-lane", true);
    await seedArtist("artist-delete-credit");
    await seedProjectedTrack({
      artistIds: [{ id: "artist-delete-credit" }],
      key: null,
      labelId: "artist-delete-lane",
      releaseDate: null,
      trackId: "artist-delete-gap",
    });
    await rebuildPublicProjection(db, "artist_qualification", {
      generation: "artist-delete-base",
      limit: 1,
      now: () => new Date(OLD),
    });

    let intercepted = false;
    const racingClient: PublicProjectionClient = {
      batch: async (statements, mode) => {
        const isRebuildWrite = statements.some((statement) => {
          const sql =
            typeof statement === "string"
              ? statement
              : Array.isArray(statement)
                ? statement[0]
                : statement.sql;
          return sql.includes("delete from artist_qualification_contributions");
        });
        if (!intercepted && isRebuildWrite) {
          intercepted = true;
          await db.batch(
            [
              {
                args: [],
                sql: `delete from track_artists where track_id = 'artist-delete-gap'`,
              },
              ...markPublicProjectionSourceChangedStatements(
                [{ subjectId: "artist-delete-gap", subjectType: "track" }],
                "artist-edges-deleted",
                ["artist_qualification"],
                { now: "2026-01-10T00:00:00.000Z" },
              ),
            ],
            "write",
          );
          expect(
            await repairPublicProjectionChunk(db, {
              limit: 1,
              now: () => new Date("2026-01-10T00:00:00.000Z"),
              projection: "artist_qualification",
            }),
          ).toEqual({ fanout: 0, repaired: 1 });
        }
        return db.batch(statements, mode);
      },
      execute: db.execute.bind(db),
    };

    await expect(
      runPublicProjectionRebuildChunk(racingClient, "artist_qualification", {
        boundedCleanup: true,
        generation: "artist-delete-rebuild",
        limit: 1,
        newGeneration: true,
        now: () => new Date("2026-01-10T00:00:00.000Z"),
      }),
    ).rejects.toThrow(
      "artist_qualification source epoch changed during rebuild page; retry required",
    );
    expect(intercepted).toBe(true);
    expect(
      Number(
        (
          await db.execute(`select count(*) as n from artist_qualification_contributions
            where track_id = 'artist-delete-gap'`)
        ).rows[0]?.n,
      ),
    ).toBe(0);
    expect(
      Number(
        (
          await db.execute(`select count(*) as n from artist_qualification
            where artist_id = 'artist-delete-credit'`)
        ).rows[0]?.n,
      ),
    ).toBe(0);
    expect(
      (await db.execute(`select cursor from artist_qualification_state where scope = 'artists'`))
        .rows[0]?.cursor,
    ).toBeNull();
  });

  it("packs high-credit artist plans whole under the remote statement ceiling", async () => {
    await seedHighCreditTracks(["credit-track-a", "credit-track-b"], 180);
    const writeBatches: string[][] = [];
    let maximumStatements = 0;
    const boundedClient: PublicProjectionClient = {
      batch: async (statements, mode) => {
        const trackDeletes = statements.flatMap((statement) => {
          const sql =
            typeof statement === "string"
              ? statement
              : Array.isArray(statement)
                ? statement[0]
                : statement.sql;
          if (!sql.includes("delete from artist_qualification_contributions")) {
            return [];
          }
          const args =
            typeof statement === "string"
              ? undefined
              : Array.isArray(statement)
                ? statement[1]
                : statement.args;
          const trackId = Array.isArray(args) ? args[0] : undefined;
          return typeof trackId === "string" ? [trackId] : [];
        });
        if (trackDeletes.length > 0) {
          writeBatches.push(trackDeletes);
          maximumStatements = Math.max(maximumStatements, statements.length);
        }
        return db.batch(statements, mode);
      },
      execute: db.execute.bind(db),
    };

    const rebuilt = await runPublicProjectionRebuildChunk(boundedClient, "artist_qualification", {
      boundedCleanup: true,
      generation: "artist-credit-bounded",
      limit: 2,
      newGeneration: true,
      now: () => NOW,
    });
    expect(rebuilt.checkpoint.cursor).toBe("credit-track-b");
    expect(writeBatches).toEqual([["credit-track-a"], ["credit-track-b"]]);
    expect(maximumStatements).toBeLessThanOrEqual(PUBLIC_PROJECTION_WRITE_STATEMENT_LIMIT);
    expect(
      Number(
        (
          await db.execute(`select count(*) as n from artist_qualification_contributions
            where generation = 'artist-credit-bounded'`)
        ).rows[0]?.n,
      ),
    ).toBe(360);
  });

  it("retries the largest admitted high-credit plan after projection commit but before cursor commit", async () => {
    await seedHighCreditTracks(["credit-track-retry-boundary"], 199);
    let cursorFailurePending = true;
    const failingCursorClient: PublicProjectionClient = {
      batch: db.batch.bind(db),
      execute: async (statement) => {
        const sql =
          typeof statement === "string"
            ? statement
            : Array.isArray(statement)
              ? statement[0]
              : statement.sql;
        if (cursorFailurePending && sql.includes("set cursor = ?, scanned_count")) {
          cursorFailurePending = false;
          throw new Error("injected cursor write failure after projection commit");
        }
        return db.execute(statement);
      },
    };

    await expect(
      runPublicProjectionRebuildChunk(failingCursorClient, "artist_qualification", {
        boundedCleanup: true,
        generation: "artist-credit-retry-boundary",
        limit: 1,
        newGeneration: true,
        now: () => NOW,
      }),
    ).rejects.toThrow("injected cursor write failure after projection commit");
    expect(
      Number(
        (
          await db.execute(`select count(*) as n from artist_qualification_contributions
            where track_id = 'credit-track-retry-boundary'`)
        ).rows[0]?.n,
      ),
    ).toBe(199);
    expect(
      (await db.execute(`select cursor from artist_qualification_state where scope = 'artists'`))
        .rows[0]?.cursor,
    ).toBeNull();

    const retryProbe = projectionClientProbe();
    const retried = await runPublicProjectionRebuildChunk(
      retryProbe.client,
      "artist_qualification",
      {
        boundedCleanup: true,
        generation: "artist-credit-retry-boundary",
        limit: 1,
        now: () => NOW,
      },
    );
    expect(retried.checkpoint.cursor).toBe("credit-track-retry-boundary");
    expect(retryProbe.evidence.maximumBatchStatements).toBeLessThanOrEqual(
      PUBLIC_PROJECTION_WRITE_STATEMENT_LIMIT,
    );
    expect(
      Number(
        (
          await db.execute(`select count(*) as n from artist_qualification_contributions
            where track_id = 'credit-track-retry-boundary'`)
        ).rows[0]?.n,
      ),
    ).toBe(199);
    expect(
      Number(
        (
          await db.execute(`select max(enabled_credit_half_units) as n
            from artist_qualification where artist_id >= 'credit-' and artist_id < 'credit.'`)
        ).rows[0]?.n,
      ),
    ).toBe(2);
  });

  it("fails closed before splitting one artist plan that exceeds the statement ceiling", async () => {
    await seedHighCreditTracks(["credit-track-oversized"], 200);
    await expect(
      runPublicProjectionRebuildChunk(db, "artist_qualification", {
        boundedCleanup: true,
        generation: "artist-credit-oversized",
        limit: 1,
        newGeneration: true,
        now: () => NOW,
      }),
    ).rejects.toThrow(
      "artist qualification projection plan for track credit-track-oversized requires 803 statements; per-plan limit is 799",
    );
    expect(
      (await db.execute(`select cursor from artist_qualification_state where scope = 'artists'`))
        .rows[0]?.cursor,
    ).toBeNull();
    expect(
      Number(
        (
          await db.execute(`select count(*) as n from artist_qualification_contributions
            where track_id = 'credit-track-oversized'`)
        ).rows[0]?.n,
      ),
    ).toBe(0);
  });

  it("bounds source and cleanup pages for both production rebuild targets", async () => {
    await seedProjectionWorld();
    for (const projection of ["public_aggregates", "artist_qualification"] as const) {
      let complete = false;
      for (let chunk = 0; chunk < 20 && !complete; chunk += 1) {
        const result = await runPublicProjectionRebuildChunk(db, projection, {
          boundedCleanup: true,
          generation: `${projection}-bounded`,
          limit: 1,
          newGeneration: chunk === 0,
        });
        expect(result.scanned).toBeLessThanOrEqual(1);
        complete = result.complete;
      }
      expect(complete).toBe(true);
    }
    const audit = await auditPublicProjections(db);
    expect(audit.aggregatesMatched).toBe(true);
    expect(audit.artistMatched).toBe(true);
  });

  it("removes recent live artist contributions whose source track is absent", async () => {
    await seedProjectionWorld();
    await rebuildAll();
    await db.execute({
      args: ["2026-01-10T01:00:00.000Z"],
      sql: `insert into artist_qualification_contributions
        (track_id, artist_id, certified_contribution, enabled_credit_half_units,
         generation, source_version, updated_at)
        values ('missing-recent-track', 'primary', 1, 0, 'live', 'recent-orphan', ?)`,
    });

    let complete = false;
    for (let chunk = 0; chunk < 20 && !complete; chunk += 1) {
      const result = await runPublicProjectionRebuildChunk(db, "artist_qualification", {
        boundedCleanup: true,
        generation: "artist-source-missing-cleanup",
        limit: 2,
        newGeneration: chunk === 0,
        now: () => new Date("2026-01-10T00:00:00.000Z"),
      });
      complete = result.complete;
    }

    expect(complete).toBe(true);
    expect(
      Number(
        (
          await db.execute(`select count(*) as n from artist_qualification_contributions
            where track_id = 'missing-recent-track'`)
        ).rows[0]?.n,
      ),
    ).toBe(0);
    expect((await auditPublicProjections(db)).artistMatched).toBe(true);
  });

  it("replaces recent live artist drift when the rebuild source epoch is stable", async () => {
    await seedProjectionWorld();
    await rebuildAll();
    await db.execute({
      args: ["2026-01-10T01:00:00.000Z"],
      sql: `update artist_qualification_contributions
        set certified_contribution = 1, enabled_credit_half_units = 0,
            generation = 'live', source_version = 'stale-live', updated_at = ?
        where track_id = 'track-null' and artist_id = 'primary'`,
    });

    let complete = false;
    for (let chunk = 0; chunk < 20 && !complete; chunk += 1) {
      const result = await runPublicProjectionRebuildChunk(db, "artist_qualification", {
        boundedCleanup: true,
        generation: "artist-stable-epoch-cleanup",
        limit: 2,
        newGeneration: chunk === 0,
        now: () => new Date("2026-01-10T00:00:00.000Z"),
      });
      complete = result.complete;
    }

    expect(complete).toBe(true);
    expect((await auditPublicProjections(db)).artistMatched).toBe(true);
  });

  it("executes each 500-track rebuild page through fixed VALUES-backed write subpages", async () => {
    await seedBulkProjectionWorld();

    const aggregateProbe = projectionClientProbe();
    const aggregate = await runPublicProjectionRebuildChunk(
      aggregateProbe.client,
      "public_aggregates",
      {
        boundedCleanup: true,
        generation: "aggregate-bulk",
        limit: 500,
        newGeneration: true,
        now: () => NOW,
      },
    );
    expect(aggregate.scanned).toBe(500);
    expect(aggregate.checkpoint.cursor).toBe("bulk-499");
    expect(aggregateProbe.evidence.writeSubpages).toBe(500 / PUBLIC_PROJECTION_WRITE_SUBPAGE_SIZE);
    expect(aggregateProbe.evidence.batchCalls).toBeLessThanOrEqual(11);
    expect(aggregateProbe.evidence.executeCalls).toBeLessThanOrEqual(16);
    expect(aggregateProbe.evidence.maximumBatchStatements).toBeLessThanOrEqual(350);
    const aggregatePageReads = aggregateProbe.evidence.executeSql.filter((sql) =>
      sql.includes("with selected(track_id) as (values"),
    );
    expect(aggregatePageReads).toHaveLength(10);
    expect(aggregatePageReads.every((sql) => !sql.toLowerCase().includes("union all"))).toBe(true);

    const artistProbe = projectionClientProbe();
    const artists = await runPublicProjectionRebuildChunk(
      artistProbe.client,
      "artist_qualification",
      {
        boundedCleanup: true,
        generation: "artists-bulk",
        limit: 500,
        newGeneration: true,
        now: () => NOW,
      },
    );
    expect(artists.scanned).toBe(500);
    expect(artists.checkpoint.cursor).toBe("bulk-499");
    expect(artistProbe.evidence.writeSubpages).toBe(10);
    expect(artistProbe.evidence.batchCalls).toBeLessThanOrEqual(11);
    expect(artistProbe.evidence.executeCalls).toBeLessThanOrEqual(36);
    expect(artistProbe.evidence.maximumBatchStatements).toBeLessThanOrEqual(350);
    const artistPageReads = artistProbe.evidence.executeSql.filter((sql) =>
      sql.includes("with selected(track_id) as (values"),
    );
    expect(artistPageReads).toHaveLength(30);
    expect(artistPageReads.every((sql) => !sql.toLowerCase().includes("union all"))).toBe(true);
  });

  it("retries a partially committed rebuild page without double-counting", async () => {
    await seedBulkProjectionWorld();
    const failedProbe = projectionClientProbe({ failWriteSubpage: 3 });
    await expect(
      runPublicProjectionRebuildChunk(failedProbe.client, "public_aggregates", {
        boundedCleanup: true,
        generation: "aggregate-retry",
        limit: 500,
        newGeneration: true,
        now: () => NOW,
      }),
    ).rejects.toThrow("injected projection write-subpage failure");
    expect(
      Number(
        (
          await db.execute(`select count(*) as n from public_aggregate_membership
            where generation = 'aggregate-retry'`)
        ).rows[0]?.n ?? 0,
      ),
    ).toBe(100);
    expect(
      (await db.execute(`select cursor from public_aggregate_state where scope = 'tracks'`)).rows[0]
        ?.cursor,
    ).toBeNull();

    const retryProbe = projectionClientProbe();
    const retry = await runPublicProjectionRebuildChunk(retryProbe.client, "public_aggregates", {
      boundedCleanup: true,
      generation: "aggregate-retry",
      limit: 500,
      now: () => NOW,
    });
    expect(retry.scanned).toBe(500);
    expect(retry.checkpoint.cursor).toBe("bulk-499");
    const [membership, aggregateState, sourceBuckets, projectedBuckets] = await Promise.all([
      db.execute(`select count(*) as n from public_aggregate_membership`),
      db.execute(`select default_track_total from public_aggregate_state where scope = 'tracks'`),
      db.execute(`select aggregate_kind, bucket, count(*) as track_count from (
          select 'release_date_bucket' as aggregate_kind, substr(release_date, 1, 4) as bucket
          from tracks where track_id <= 'bulk-499' and release_date is not null
          union all
          select 'key', key from tracks where track_id <= 'bulk-499' and key is not null
        ) group by aggregate_kind, bucket order by aggregate_kind, bucket`),
      db.execute(`select aggregate_kind, bucket, track_count from public_aggregate_counts
        order by aggregate_kind, bucket`),
    ]);
    expect(Number(membership.rows[0]?.n ?? 0)).toBe(500);
    expect(Number(aggregateState.rows[0]?.default_track_total ?? 0)).toBe(500);
    expect(projectedBuckets.rows).toEqual(sourceBuckets.rows);
    expect(retryProbe.evidence.writeSubpages).toBe(10);
  });

  it("repairs 500 aggregate markers without restoring per-track round trips", async () => {
    await seedBulkProjectionWorld(500);
    await rebuildPublicProjection(db, "public_aggregates", {
      generation: "aggregate-repair-source",
      limit: 500,
      now: () => NOW,
    });
    await db.execute(`update tracks set key = case when key = 'Am' then 'Bm' else key end
      where track_id >= 'bulk-' and track_id < 'bulk.'`);
    await db.execute(`update public_aggregate_state set source_epoch = 1
      where scope = 'tracks'`);
    await db.execute({
      args: [OLD, OLD],
      sql: `insert into projection_repairs
        (projection, subject_type, subject_id, source_epoch, source_version, created_at, updated_at)
        select 'public_aggregates', 'track', track_id, 1, 'bulk-repair', ?, ?
        from tracks where track_id >= 'bulk-' and track_id < 'bulk.'`,
    });

    const probe = projectionClientProbe();
    const repaired = await repairPublicProjectionChunk(probe.client, {
      limit: 500,
      now: () => NOW,
      projection: "public_aggregates",
    });
    expect(repaired).toEqual({ fanout: 0, repaired: 500 });
    expect(probe.evidence.writeSubpages).toBe(10);
    expect(probe.evidence.batchCalls).toBe(10);
    expect(probe.evidence.executeCalls).toBe(11);
    expect(
      Number(
        (
          await db.execute(`select count(*) as n from projection_repairs
            where projection = 'public_aggregates'`)
        ).rows[0]?.n,
      ),
    ).toBe(0);
    const [sourceBuckets, projectedBuckets] = await Promise.all([
      db.execute(`select aggregate_kind, bucket, count(*) as track_count from (
          select 'release_date_bucket' as aggregate_kind, substr(release_date, 1, 4) as bucket
          from tracks where release_date is not null
          union all select 'key', key from tracks where key is not null
        ) group by aggregate_kind, bucket order by aggregate_kind, bucket`),
      db.execute(`select aggregate_kind, bucket, track_count from public_aggregate_counts
        order by aggregate_kind, bucket`),
    ]);
    expect(projectedBuckets.rows).toEqual(sourceBuckets.rows);
  });

  it("cleans a 500-row stale generation through bounded subpages before moving its cursor", async () => {
    await db.execute({
      args: [499, publicTrackSourceVersion({ key: "Am", releaseDate: "2024-01-01" }), OLD],
      sql: `with recursive source(n) as (
          select 0 union all select n + 1 from source where n < ?
        )
        insert into public_aggregate_membership
          (track_id, release_date_bucket, key_bucket, generation, source_version, updated_at)
        select printf('stale-%03d', n), '2024', 'Am', 'stale', ?, ? from source`,
    });
    await db.execute({
      args: [500, OLD, OLD, 500, OLD, OLD],
      sql: `insert into public_aggregate_counts
        (aggregate_kind, bucket, track_count, generation, source_version, updated_at)
        values ('release_date_bucket', '2024', ?, 'stale', ?, ?),
          ('key', 'Am', ?, 'stale', ?, ?)`,
    });

    const probe = projectionClientProbe();
    const cleanup = await runPublicProjectionRebuildChunk(probe.client, "public_aggregates", {
      boundedCleanup: true,
      generation: "aggregate-cleanup",
      limit: 500,
      newGeneration: true,
      now: () => NOW,
    });
    expect(cleanup.scanned).toBe(500);
    expect(cleanup.complete).toBe(false);
    expect(probe.evidence.writeSubpages).toBe(10);
    expect(
      Number(
        (await db.execute(`select count(*) as n from public_aggregate_membership`)).rows[0]?.n,
      ),
    ).toBe(0);
    expect(
      Number((await db.execute(`select count(*) as n from public_aggregate_counts`)).rows[0]?.n),
    ).toBe(0);
    const cleanupState = await db.execute(
      `select json_extract(value, '$.cursor') as cursor from settings
        where key like 'projection_cleanup_public_aggregates_v1:%'`,
    );
    expect(cleanupState.rows[0]?.cursor).toBe("stale-499");
  });
});
