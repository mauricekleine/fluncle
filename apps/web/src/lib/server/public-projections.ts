import { type Client, type InValue } from "@libsql/client";
import { createHash } from "node:crypto";

import { QUALIFIED_ARTISTS_SQL } from "./catalogue";
import { hubCorpusFingerprint, hubPageAnchorsFromRows } from "./hub-page-anchors";
import {
  PUBLIC_ANCHOR_FORMAT_VERSION,
  readStoredTrackHubAnchorsForAudit,
} from "./public-projection-cutover";
import {
  TRACKS_HUB_ANCHOR_ADDRESS,
  TRACKS_HUB_PAGE_SIZE,
  tracksHubAnchorExtractionQuery,
  tracksHubCountQuery,
  tracksHubIdPageQuery,
} from "./tracks-hub";
import {
  ensurePublicProjectionState,
  markArtistQualificationRepairStatements,
  markPublicTrackSourceChangedStatements,
  PUBLIC_PROJECTION_LIVE_GENERATION,
  type PublicProjectionStatement,
} from "./public-projection-source-maintenance";

export {
  markArtistQualificationRepairStatements,
  markPublicLabelSourceChangedStatements,
  markPublicTrackSourceChangedStatements,
  PUBLIC_PROJECTION_LIVE_GENERATION,
} from "./public-projection-source-maintenance";
export { PUBLIC_ANCHOR_FORMAT_VERSION } from "./public-projection-cutover";

export const MAX_PUBLIC_PROJECTION_CHUNK_SIZE = 500;

export type PublicProjectionClient = Pick<Client, "batch" | "execute">;
export type { PublicProjectionStatement } from "./public-projection-source-maintenance";
export type PublicProjectionName = "artist_qualification" | "public_aggregates";

export type TrackAnchorSourceCursor = {
  id: null | string;
  key: null | string;
  phase: "non_null" | "null";
};

export type TrackAnchorSourceRow = {
  release_date: null | string;
  track_id: string;
};

export type PublicProjectionAudit = {
  artistProjectionDigest: string;
  artistSourceDigest: string;
  artistMatched: boolean;
  aggregateProjectionDigest: string;
  aggregateSourceDigest: string;
  aggregatesMatched: boolean;
  scheduledArtistRepairs: string[];
  scheduledTrackRepairs: string[];
};

export type PublicProjectionRebuildCheckpoint = {
  completedAt: null | string;
  cursor: null | string;
  generation: string;
  projection: PublicProjectionName;
  projectedCount: number;
  projectedDigest: null | string;
  rebuildStartEpoch: number;
  scannedCount: number;
  sourceCount: number;
  sourceDigest: null | string;
  sourceEpoch: number;
  startedAt: string;
  state: "complete" | "running";
  updatedAt: string;
};

type ProjectionRepairMarker = {
  projection: PublicProjectionName;
  sourceEpoch: number;
  sourceVersion: string;
  subjectId: string;
  subjectType: "artist" | "label" | "track";
};

type AggregateMembership = {
  generation: string;
  keyBucket: null | string;
  releaseDateBucket: null | string;
  sourceVersion: string;
  trackId: string;
  updatedAt: string;
};

type TrackProjectionSource = {
  keyBucket: null | string;
  releaseDate: null | string;
  releaseDateBucket: null | string;
  sourceVersion: string;
  trackId: string;
};

type ArtistContribution = {
  artistId: string;
  certifiedContribution: number;
  enabledCreditHalfUnits: number;
  trackId: string;
};

type AggregateCountRow = {
  aggregate_kind: string;
  bucket: string;
  track_count: number;
};

type ArtistCountRow = {
  artist_id: string;
  certified: number;
  half_units: number;
};

type ArtistContributionRow = {
  artist_id: string;
  certified_contribution: number;
  enabled_credit_half_units: number;
  track_id: string;
};

function assertNonEmpty(value: string, name: string): void {
  if (!value.trim()) {
    throw new Error(`${name} must not be empty`);
  }
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PUBLIC_PROJECTION_CHUNK_SIZE) {
    throw new Error(
      `public projection limit must be an integer from 1 through ${MAX_PUBLIC_PROJECTION_CHUNK_SIZE}`,
    );
  }
}

/** One exact indexed phase of the default release-hub source walk. */
export function trackAnchorSourcePageQuery(
  cursor: TrackAnchorSourceCursor,
  limit: number,
): { args: InValue[]; sql: string } {
  assertLimit(limit);
  if (cursor.phase === "null") {
    return cursor.id === null
      ? {
          args: [limit],
          sql: `select release_date, track_id from tracks
            indexed by tracks_release_date_track_id_idx
            where release_date is null order by track_id desc limit ?`,
        }
      : {
          args: [cursor.id, limit],
          sql: `select release_date, track_id from tracks
            indexed by tracks_release_date_track_id_idx
            where release_date is null and track_id < ? order by track_id desc limit ?`,
        };
  }
  if (cursor.id === null || cursor.key === null) {
    if (cursor.id !== null || cursor.key !== null) {
      throw new Error("non-NULL anchor cursor requires both key columns");
    }
    return {
      args: [limit],
      sql: `select release_date, track_id from tracks
        indexed by tracks_release_date_track_id_idx
        where release_date is not null order by release_date desc, track_id desc limit ?`,
    };
  }
  return {
    args: [cursor.key, cursor.id, limit],
    sql: `select release_date, track_id from tracks
      indexed by tracks_release_date_track_id_idx
      where (release_date, track_id) < (?, ?)
      order by release_date desc, track_id desc limit ?`,
  };
}

/** Fill at most one bounded page while durably exposing the non-NULL → NULL phase transition. */
export async function readTrackAnchorSourcePage(
  client: Pick<Client, "execute">,
  cursor: TrackAnchorSourceCursor,
  limit: number,
): Promise<{
  complete: boolean;
  cursor: TrackAnchorSourceCursor;
  rows: TrackAnchorSourceRow[];
}> {
  const first = await client.execute(trackAnchorSourcePageQuery(cursor, limit));
  const firstRows = first.rows as unknown as TrackAnchorSourceRow[];
  if (cursor.phase === "null" || firstRows.length >= limit) {
    const terminal = firstRows.at(-1);
    return {
      complete: firstRows.length < limit,
      cursor: {
        id: terminal?.track_id ?? cursor.id,
        key: cursor.phase === "null" ? null : (terminal?.release_date ?? cursor.key),
        phase: cursor.phase,
      },
      rows: firstRows,
    };
  }

  const remaining = limit - firstRows.length;
  const nullResult = await client.execute(
    trackAnchorSourcePageQuery({ id: null, key: null, phase: "null" }, remaining),
  );
  const nullRows = nullResult.rows as unknown as TrackAnchorSourceRow[];
  const terminal = nullRows.at(-1);
  return {
    complete: firstRows.length + nullRows.length < limit,
    cursor: {
      id: terminal?.track_id ?? null,
      key: null,
      phase: "null",
    },
    rows: [...firstRows, ...nullRows],
  };
}

function nowIso(now: (() => Date) | undefined): string {
  return (now ?? (() => new Date()))().toISOString();
}

function digestRows(rows: readonly unknown[]): string {
  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(`${JSON.stringify(row)}\n`);
  }
  return hash.digest("hex");
}

/** Exact source token; JSON preserves the NULL/empty/malformed distinctions the projection keeps. */
export function publicTrackSourceVersion(track: {
  key: null | string;
  releaseDate: null | string;
}): string {
  return JSON.stringify([track.releaseDate, track.key]);
}

function releaseDateFromSourceVersion(sourceVersion: string): null | string | undefined {
  try {
    const parsed = JSON.parse(sourceVersion) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) {
      return undefined;
    }
    const value = parsed[0];
    return value === null || typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readRepairMarker(
  client: PublicProjectionClient,
  projection: PublicProjectionName,
  subjectType: "artist" | "label" | "track",
  subjectId: string,
): Promise<ProjectionRepairMarker | undefined> {
  const result = await client.execute({
    args: [projection, subjectType, subjectId],
    sql: `select projection, subject_type, subject_id, source_epoch, source_version
      from projection_repairs
      where projection = ? and subject_type = ? and subject_id = ? limit 1`,
  });
  const row = result.rows[0] as
    | {
        projection: string;
        source_epoch: number;
        source_version: string;
        subject_id: string;
        subject_type: string;
      }
    | undefined;
  if (row === undefined) {
    return undefined;
  }
  if (
    (row.projection !== "artist_qualification" && row.projection !== "public_aggregates") ||
    (row.subject_type !== "artist" && row.subject_type !== "label" && row.subject_type !== "track")
  ) {
    throw new Error("invalid public projection repair marker");
  }
  return {
    projection: row.projection,
    sourceEpoch: Number(row.source_epoch),
    sourceVersion: row.source_version,
    subjectId: row.subject_id,
    subjectType: row.subject_type,
  };
}

function markerGuard(marker: ProjectionRepairMarker): { args: (number | string)[]; sql: string } {
  return {
    args: [
      marker.projection,
      marker.subjectType,
      marker.subjectId,
      marker.sourceEpoch,
      marker.sourceVersion,
    ],
    sql: `exists (
      select 1 from projection_repairs
      where projection = ? and subject_type = ? and subject_id = ?
        and source_epoch = ? and source_version = ?
    )`,
  };
}

async function readTrackProjectionSource(
  client: PublicProjectionClient,
  trackId: string,
): Promise<TrackProjectionSource | undefined> {
  const result = await client.execute({
    args: [trackId],
    sql: `select track_id, release_date, substr(release_date, 1, 4) as release_date_bucket,
             key as key_bucket
      from tracks where track_id = ? limit 1`,
  });
  const row = result.rows[0] as
    | {
        key_bucket: null | string;
        release_date: null | string;
        release_date_bucket: null | string;
        track_id: string;
      }
    | undefined;
  return row === undefined
    ? undefined
    : {
        keyBucket: row.key_bucket,
        releaseDate: row.release_date,
        releaseDateBucket: row.release_date_bucket,
        sourceVersion: publicTrackSourceVersion({
          key: row.key_bucket,
          releaseDate: row.release_date,
        }),
        trackId: row.track_id,
      };
}

async function readAggregateMembership(
  client: PublicProjectionClient,
  trackId: string,
): Promise<AggregateMembership | undefined> {
  const result = await client.execute({
    args: [trackId],
    sql: `select track_id, release_date_bucket, key_bucket, generation, source_version, updated_at
      from public_aggregate_membership where track_id = ? limit 1`,
  });
  const row = result.rows[0] as
    | {
        generation: string;
        key_bucket: null | string;
        release_date_bucket: null | string;
        source_version: string;
        track_id: string;
        updated_at: string;
      }
    | undefined;
  return row === undefined
    ? undefined
    : {
        generation: row.generation,
        keyBucket: row.key_bucket,
        releaseDateBucket: row.release_date_bucket,
        sourceVersion: row.source_version,
        trackId: row.track_id,
        updatedAt: row.updated_at,
      };
}

function decrementAggregateBucketStatement(
  kind: "key" | "release_date_bucket",
  bucket: string,
  guard?: ReturnType<typeof markerGuard>,
): PublicProjectionStatement {
  return {
    args: [kind, bucket, ...(guard?.args ?? [])],
    sql: `update public_aggregate_counts set track_count = track_count - 1
      where aggregate_kind = ? and bucket = ? and track_count > 0
      ${guard ? `and ${guard.sql}` : ""}`,
  };
}

function incrementAggregateBucketStatement(
  kind: "key" | "release_date_bucket",
  bucket: string,
  generation: string,
  sourceVersion: string,
  updatedAt: string,
  guard?: ReturnType<typeof markerGuard>,
): PublicProjectionStatement {
  return {
    args: [kind, bucket, generation, sourceVersion, updatedAt, ...(guard?.args ?? [])],
    sql: `insert into public_aggregate_counts
      (aggregate_kind, bucket, track_count, generation, source_version, updated_at)
      select ?, ?, 1, ?, ?, ? ${guard ? `where ${guard.sql}` : ""}
      on conflict(aggregate_kind, bucket) do update set
        track_count = public_aggregate_counts.track_count + 1,
        generation = excluded.generation,
        source_version = excluded.source_version,
        updated_at = excluded.updated_at`,
  };
}

function cleanAggregateEpochStatement(updatedAt: string): PublicProjectionStatement {
  return {
    args: [updatedAt],
    sql: `update public_aggregate_state
      set aggregate_epoch = case
            when exists (select 1 from projection_repairs where projection = 'public_aggregates')
              then min(source_epoch, (select min(source_epoch) - 1 from projection_repairs
                where projection = 'public_aggregates'))
            else source_epoch end,
          updated_at = ?
      where scope = 'tracks'`,
  };
}

async function repairPublicAggregateTrackProjection(
  client: PublicProjectionClient,
  trackId: string,
  options: {
    generation: string;
    guard?: ReturnType<typeof markerGuard>;
    marker?: ProjectionRepairMarker;
    now: string;
    preserveAfter?: string;
  },
): Promise<boolean> {
  const [source, old] = await Promise.all([
    readTrackProjectionSource(client, trackId),
    readAggregateMembership(client, trackId),
  ]);
  if (
    options.preserveAfter !== undefined &&
    old?.generation === PUBLIC_PROJECTION_LIVE_GENERATION &&
    old.updatedAt >= options.preserveAfter
  ) {
    return false;
  }
  const guard = options.guard;
  const writes: PublicProjectionStatement[] = [];
  if (old?.releaseDateBucket !== null && old?.releaseDateBucket !== undefined) {
    writes.push(
      decrementAggregateBucketStatement("release_date_bucket", old.releaseDateBucket, guard),
    );
  }
  if (old?.keyBucket !== null && old?.keyBucket !== undefined) {
    writes.push(decrementAggregateBucketStatement("key", old.keyBucket, guard));
  }
  writes.push({
    args: [trackId, ...(guard?.args ?? [])],
    sql: `delete from public_aggregate_membership where track_id = ?
      ${guard ? `and ${guard.sql}` : ""}`,
  });

  if (source !== undefined) {
    writes.push({
      args: [
        source.trackId,
        source.releaseDateBucket,
        source.keyBucket,
        options.generation,
        source.sourceVersion,
        options.now,
        ...(guard?.args ?? []),
      ],
      sql: `insert into public_aggregate_membership
        (track_id, release_date_bucket, key_bucket, generation, source_version, updated_at)
        select ?, ?, ?, ?, ?, ? ${guard ? `where ${guard.sql}` : ""}
        on conflict(track_id) do update set
          release_date_bucket = excluded.release_date_bucket,
          key_bucket = excluded.key_bucket,
          generation = excluded.generation,
          source_version = excluded.source_version,
          updated_at = excluded.updated_at`,
    });
    if (source.releaseDateBucket !== null) {
      writes.push(
        incrementAggregateBucketStatement(
          "release_date_bucket",
          source.releaseDateBucket,
          options.generation,
          source.sourceVersion,
          options.now,
          guard,
        ),
      );
    }
    if (source.keyBucket !== null) {
      writes.push(
        incrementAggregateBucketStatement(
          "key",
          source.keyBucket,
          options.generation,
          source.sourceVersion,
          options.now,
          guard,
        ),
      );
    }
  }

  const oldReleaseDate = old === undefined ? null : releaseDateFromSourceVersion(old.sourceVersion);
  const orderChanged =
    old === undefined ||
    source === undefined ||
    oldReleaseDate === undefined ||
    oldReleaseDate !== source.releaseDate;
  writes.push({
    args: [
      (source === undefined ? 0 : 1) - (old === undefined ? 0 : 1),
      orderChanged ? 1 : 0,
      options.now,
      ...(guard?.args ?? []),
    ],
    sql: `update public_aggregate_state
      set default_track_total = max(0, default_track_total + ?),
          release_hub_order_epoch = release_hub_order_epoch + ?, updated_at = ?
      where scope = 'tracks' ${guard ? `and ${guard.sql}` : ""}`,
  });
  writes.push({
    args: guard?.args ?? [],
    sql: `delete from public_aggregate_counts where track_count = 0
      ${guard ? `and ${guard.sql}` : ""}`,
  });
  if (options.marker !== undefined) {
    writes.push({
      args: [
        options.marker.projection,
        options.marker.subjectType,
        options.marker.subjectId,
        options.marker.sourceEpoch,
        options.marker.sourceVersion,
      ],
      sql: `delete from projection_repairs
        where projection = ? and subject_type = ? and subject_id = ?
          and source_epoch = ? and source_version = ?`,
    });
    writes.push(cleanAggregateEpochStatement(options.now));
  }
  const results = await client.batch(writes, "write");
  return options.marker === undefined || (results.at(-2)?.rowsAffected ?? 0) > 0;
}

export async function repairPublicAggregateTrack(
  client: PublicProjectionClient,
  trackId: string,
  options: { now?: () => Date } = {},
): Promise<boolean> {
  const marker = await readRepairMarker(client, "public_aggregates", "track", trackId);
  if (marker === undefined) {
    return false;
  }
  return repairPublicAggregateTrackProjection(client, trackId, {
    generation: PUBLIC_PROJECTION_LIVE_GENERATION,
    guard: markerGuard(marker),
    marker,
    now: nowIso(options.now),
  });
}

async function readTrackArtistContributions(
  client: PublicProjectionClient,
  trackId: string,
): Promise<ArtistContribution[]> {
  const result = await client.execute({
    args: [trackId],
    sql: `select ta.track_id, ta.artist_id,
             case when f.track_id is null then 0 else 1 end as certified_contribution,
             case when l.seed_state = 'enabled'
               then case when ta.role = 'remixer' then 1 else 2 end else 0 end
               as enabled_credit_half_units
      from track_artists ta
      join tracks t on t.track_id = ta.track_id
      left join findings f on f.track_id = ta.track_id
      left join labels l on l.id = t.label_id
      where ta.track_id = ?
      order by ta.artist_id`,
  });
  return (
    result.rows as unknown as {
      artist_id: string;
      certified_contribution: number;
      enabled_credit_half_units: number;
      track_id: string;
    }[]
  ).map((row) => ({
    artistId: row.artist_id,
    certifiedContribution: Number(row.certified_contribution),
    enabledCreditHalfUnits: Number(row.enabled_credit_half_units),
    trackId: row.track_id,
  }));
}

async function readStoredArtistContributions(
  client: PublicProjectionClient,
  trackId: string,
): Promise<(ArtistContribution & { generation: string; updatedAt: string })[]> {
  const result = await client.execute({
    args: [trackId],
    sql: `select track_id, artist_id, certified_contribution, enabled_credit_half_units,
             generation, updated_at
      from artist_qualification_contributions where track_id = ? order by artist_id`,
  });
  return (
    result.rows as unknown as {
      artist_id: string;
      certified_contribution: number;
      enabled_credit_half_units: number;
      generation: string;
      track_id: string;
      updated_at: string;
    }[]
  ).map((row) => ({
    artistId: row.artist_id,
    certifiedContribution: Number(row.certified_contribution),
    enabledCreditHalfUnits: Number(row.enabled_credit_half_units),
    generation: row.generation,
    trackId: row.track_id,
    updatedAt: row.updated_at,
  }));
}

function cleanArtistEpochStatement(updatedAt: string): PublicProjectionStatement {
  return {
    args: [updatedAt],
    sql: `update artist_qualification_state
      set projection_epoch = case
            when exists (select 1 from projection_repairs
              where projection = 'artist_qualification')
              then min(source_epoch, (select min(source_epoch) - 1 from projection_repairs
                where projection = 'artist_qualification'))
            else source_epoch end,
          updated_at = ?
      where scope = 'artists'`,
  };
}

async function repairArtistContributionTrackProjection(
  client: PublicProjectionClient,
  trackId: string,
  options: {
    generation: string;
    guard?: ReturnType<typeof markerGuard>;
    marker?: ProjectionRepairMarker;
    now: string;
    preserveAfter?: string;
    sourceVersion: string;
  },
): Promise<boolean> {
  const [current, old] = await Promise.all([
    readTrackArtistContributions(client, trackId),
    readStoredArtistContributions(client, trackId),
  ]);
  if (
    options.preserveAfter !== undefined &&
    old.some(
      (row) =>
        row.generation === PUBLIC_PROJECTION_LIVE_GENERATION &&
        row.updatedAt >= (options.preserveAfter ?? ""),
    )
  ) {
    return false;
  }
  const artistIds = [...new Set([...old, ...current].map((row) => row.artistId))].sort();
  const guard = options.guard;
  const writes: PublicProjectionStatement[] = [];

  for (const artistId of artistIds) {
    writes.push({
      args: [
        artistId,
        options.generation,
        options.sourceVersion,
        options.now,
        ...(guard?.args ?? []),
      ],
      sql: `insert into artist_qualification
        (artist_id, certified_finding_count, enabled_credit_half_units, is_qualified,
         generation, source_version, updated_at)
        select ?, 0, 0, 0, ?, ?, ? ${guard ? `where ${guard.sql}` : ""}
        on conflict(artist_id) do nothing`,
    });
  }
  for (const contribution of old) {
    writes.push({
      args: [
        contribution.certifiedContribution,
        contribution.enabledCreditHalfUnits,
        contribution.artistId,
        ...(guard?.args ?? []),
      ],
      sql: `update artist_qualification
        set is_qualified = case
              when max(0, certified_finding_count - ?1) > 0
                or max(0, enabled_credit_half_units - ?2) >= 6 then 1 else 0 end,
            certified_finding_count = max(0, certified_finding_count - ?1),
            enabled_credit_half_units = max(0, enabled_credit_half_units - ?2)
        where artist_id = ? ${guard ? `and ${guard.sql}` : ""}`,
    });
  }
  writes.push({
    args: [trackId, ...(guard?.args ?? [])],
    sql: `delete from artist_qualification_contributions where track_id = ?
      ${guard ? `and ${guard.sql}` : ""}`,
  });
  for (const contribution of current) {
    writes.push({
      args: [
        contribution.trackId,
        contribution.artistId,
        contribution.certifiedContribution,
        contribution.enabledCreditHalfUnits,
        options.generation,
        options.sourceVersion,
        options.now,
        ...(guard?.args ?? []),
      ],
      sql: `insert into artist_qualification_contributions
        (track_id, artist_id, certified_contribution, enabled_credit_half_units,
         generation, source_version, updated_at)
        select ?, ?, ?, ?, ?, ?, ? ${guard ? `where ${guard.sql}` : ""}
        on conflict(track_id, artist_id) do update set
          certified_contribution = excluded.certified_contribution,
          enabled_credit_half_units = excluded.enabled_credit_half_units,
          generation = excluded.generation,
          source_version = excluded.source_version,
          updated_at = excluded.updated_at`,
    });
    writes.push({
      args: [
        contribution.certifiedContribution,
        contribution.enabledCreditHalfUnits,
        options.generation,
        options.sourceVersion,
        options.now,
        contribution.artistId,
        ...(guard?.args ?? []),
      ],
      sql: `update artist_qualification
        set is_qualified = case
              when certified_finding_count + ?1 > 0
                or enabled_credit_half_units + ?2 >= 6 then 1 else 0 end,
            certified_finding_count = certified_finding_count + ?1,
            enabled_credit_half_units = enabled_credit_half_units + ?2,
            generation = ?, source_version = ?, updated_at = ?
        where artist_id = ? ${guard ? `and ${guard.sql}` : ""}`,
    });
  }
  if (artistIds.length > 0) {
    const placeholders = artistIds.map(() => "?").join(", ");
    writes.push({
      args: [
        options.generation,
        options.sourceVersion,
        options.now,
        ...artistIds,
        ...(guard?.args ?? []),
      ],
      sql: `update artist_qualification
        set is_qualified = case
              when certified_finding_count > 0 or enabled_credit_half_units >= 6 then 1 else 0 end,
            generation = ?, source_version = ?, updated_at = ?
        where artist_id in (${placeholders}) ${guard ? `and ${guard.sql}` : ""}`,
    });
    writes.push({
      args: [...artistIds, ...(guard?.args ?? [])],
      sql: `delete from artist_qualification
        where artist_id in (${placeholders}) and certified_finding_count = 0
          and enabled_credit_half_units = 0 ${guard ? `and ${guard.sql}` : ""}`,
    });
  }
  if (options.marker !== undefined) {
    writes.push({
      args: [
        options.marker.projection,
        options.marker.subjectType,
        options.marker.subjectId,
        options.marker.sourceEpoch,
        options.marker.sourceVersion,
      ],
      sql: `delete from projection_repairs
        where projection = ? and subject_type = ? and subject_id = ?
          and source_epoch = ? and source_version = ?`,
    });
    writes.push(cleanArtistEpochStatement(options.now));
  }
  if (writes.length === 0) {
    return true;
  }
  const results = await client.batch(writes, "write");
  return options.marker === undefined || (results.at(-2)?.rowsAffected ?? 0) > 0;
}

export async function repairArtistQualificationTrack(
  client: PublicProjectionClient,
  trackId: string,
  options: { now?: () => Date } = {},
): Promise<boolean> {
  const marker = await readRepairMarker(client, "artist_qualification", "track", trackId);
  if (marker === undefined) {
    return false;
  }
  return repairArtistContributionTrackProjection(client, trackId, {
    generation: PUBLIC_PROJECTION_LIVE_GENERATION,
    guard: markerGuard(marker),
    marker,
    now: nowIso(options.now),
    sourceVersion: marker.sourceVersion,
  });
}

async function repairArtistQualificationById(
  client: PublicProjectionClient,
  marker: ProjectionRepairMarker,
  options: { now?: () => Date } = {},
): Promise<boolean> {
  const totals = await client.execute({
    args: [marker.subjectId],
    sql: `select count(case when f.track_id is not null then 1 end) as certified,
             coalesce(sum(case when l.seed_state = 'enabled'
               then case when ta.role = 'remixer' then 1 else 2 end else 0 end), 0) as half_units
      from track_artists ta
      join tracks t on t.track_id = ta.track_id
      left join findings f on f.track_id = ta.track_id
      left join labels l on l.id = t.label_id
      where ta.artist_id = ?`,
  });
  const row = totals.rows[0] as { certified?: number; half_units?: number } | undefined;
  const certified = Number(row?.certified ?? 0);
  const halfUnits = Number(row?.half_units ?? 0);
  const now = nowIso(options.now);
  const guard = markerGuard(marker);
  const writes: PublicProjectionStatement[] = [];
  if (certified === 0 && halfUnits === 0) {
    writes.push({
      args: [marker.subjectId, ...guard.args],
      sql: `delete from artist_qualification where artist_id = ? and ${guard.sql}`,
    });
  } else {
    writes.push({
      args: [
        marker.subjectId,
        certified,
        halfUnits,
        certified > 0 || halfUnits >= 6 ? 1 : 0,
        PUBLIC_PROJECTION_LIVE_GENERATION,
        marker.sourceVersion,
        now,
        ...guard.args,
      ],
      sql: `insert into artist_qualification
        (artist_id, certified_finding_count, enabled_credit_half_units, is_qualified,
         generation, source_version, updated_at)
        select ?, ?, ?, ?, ?, ?, ? where ${guard.sql}
        on conflict(artist_id) do update set
          certified_finding_count = excluded.certified_finding_count,
          enabled_credit_half_units = excluded.enabled_credit_half_units,
          is_qualified = excluded.is_qualified, generation = excluded.generation,
          source_version = excluded.source_version, updated_at = excluded.updated_at`,
    });
  }
  writes.push(
    {
      args: [
        marker.projection,
        marker.subjectType,
        marker.subjectId,
        marker.sourceEpoch,
        marker.sourceVersion,
      ],
      sql: `delete from projection_repairs
        where projection = ? and subject_type = ? and subject_id = ?
          and source_epoch = ? and source_version = ?`,
    },
    cleanArtistEpochStatement(now),
  );
  const results = await client.batch(writes, "write");
  return (results.at(-2)?.rowsAffected ?? 0) > 0;
}

/** Fan one label ruling out through the `tracks_label_id_idx` slice, never through all tracks. */
export function artistQualificationLabelFanoutQuery(
  labelId: string,
  sourceEpoch: number,
  limit: number,
): PublicProjectionStatement {
  assertNonEmpty(labelId, "public projection label id");
  assertLimit(limit);
  if (!Number.isSafeInteger(sourceEpoch) || sourceEpoch < 0) {
    throw new Error("artist qualification source epoch must be a non-negative integer");
  }
  return {
    args: [labelId, sourceEpoch, limit],
    sql: `select t.track_id
      from tracks t indexed by tracks_label_id_idx
      where t.label_id = ?
        and exists (select 1 from track_artists ta where ta.track_id = t.track_id)
        and not exists (
          select 1 from projection_repairs pr
          where pr.projection = 'artist_qualification' and pr.subject_type = 'track'
            and pr.subject_id = t.track_id and pr.source_epoch >= ?
        )
      limit ?`,
  };
}

export async function fanOutArtistQualificationLabelRepair(
  client: PublicProjectionClient,
  labelId: string,
  options: { limit?: number; now?: () => Date } = {},
): Promise<{ complete: boolean; expanded: number }> {
  const limit = options.limit ?? 100;
  assertLimit(limit);
  const marker = await readRepairMarker(client, "artist_qualification", "label", labelId);
  if (marker === undefined) {
    return { complete: true, expanded: 0 };
  }
  const selected = await client.execute(
    artistQualificationLabelFanoutQuery(labelId, marker.sourceEpoch, limit),
  );
  const trackIds = (selected.rows as unknown as { track_id: string }[]).map((row) => row.track_id);
  const now = nowIso(options.now);
  const guard = markerGuard(marker);
  const writes: PublicProjectionStatement[] = trackIds.map((trackId) => ({
    args: [trackId, marker.sourceEpoch, marker.sourceVersion, now, now, ...guard.args],
    sql: `insert into projection_repairs
      (projection, subject_type, subject_id, source_epoch, source_version, created_at, updated_at)
      select 'artist_qualification', 'track', ?, ?, ?, ?, ? where ${guard.sql}
      on conflict(projection, subject_type, subject_id) do update set
        source_epoch = max(projection_repairs.source_epoch, excluded.source_epoch),
        source_version = case
          when excluded.source_epoch >= projection_repairs.source_epoch
            then excluded.source_version else projection_repairs.source_version end,
        updated_at = case
          when excluded.source_epoch >= projection_repairs.source_epoch
            then excluded.updated_at else projection_repairs.updated_at end`,
  }));
  writes.push({
    args: [
      marker.projection,
      marker.subjectType,
      marker.subjectId,
      marker.sourceEpoch,
      marker.sourceVersion,
      labelId,
      marker.sourceEpoch,
    ],
    sql: `delete from projection_repairs
      where projection = ? and subject_type = ? and subject_id = ?
        and source_epoch = ? and source_version = ?
        and not exists (
          select 1 from tracks t indexed by tracks_label_id_idx
          where t.label_id = ?
            and exists (select 1 from track_artists ta where ta.track_id = t.track_id)
            and not exists (
              select 1 from projection_repairs pr
              where pr.projection = 'artist_qualification' and pr.subject_type = 'track'
                and pr.subject_id = t.track_id and pr.source_epoch >= ?
            )
        )`,
  });
  const results = await client.batch(writes, "write");
  return { complete: (results.at(-1)?.rowsAffected ?? 0) > 0, expanded: trackIds.length };
}

async function firstRepairOfType(
  client: PublicProjectionClient,
  projection: PublicProjectionName,
  subjectType: "artist" | "label" | "track",
): Promise<ProjectionRepairMarker | undefined> {
  const result = await client.execute({
    args: [projection, subjectType],
    sql: `select projection, subject_type, subject_id, source_epoch, source_version
      from projection_repairs indexed by projection_repairs_order_idx
      where projection = ? and subject_type = ?
      order by source_epoch, subject_type, subject_id limit 1`,
  });
  const row = result.rows[0] as
    | {
        projection: PublicProjectionName;
        source_epoch: number;
        source_version: string;
        subject_id: string;
        subject_type: "artist" | "label" | "track";
      }
    | undefined;
  return row === undefined
    ? undefined
    : {
        projection: row.projection,
        sourceEpoch: Number(row.source_epoch),
        sourceVersion: row.source_version,
        subjectId: row.subject_id,
        subjectType: row.subject_type,
      };
}

export async function repairPublicProjectionChunk(
  client: PublicProjectionClient,
  options: { limit?: number; now?: () => Date; projection?: PublicProjectionName } = {},
): Promise<{ fanout: number; repaired: number }> {
  const limit = options.limit ?? 100;
  assertLimit(limit);
  const label =
    options.projection === "public_aggregates"
      ? undefined
      : await firstRepairOfType(client, "artist_qualification", "label");
  if (label !== undefined) {
    const result = await fanOutArtistQualificationLabelRepair(client, label.subjectId, options);
    return { fanout: result.expanded, repaired: 0 };
  }

  let attempted = 0;
  let repaired = 0;
  const projections = options.projection
    ? ([options.projection] as const)
    : (["public_aggregates", "artist_qualification"] as const);
  for (const projection of projections) {
    const result = await client.execute({
      args: [projection, limit - attempted],
      sql: `select subject_id from projection_repairs indexed by projection_repairs_order_idx
        where projection = ? and subject_type = 'track'
        order by source_epoch, subject_type, subject_id limit ?`,
    });
    for (const row of result.rows as unknown as { subject_id: string }[]) {
      attempted += 1;
      const changed =
        projection === "public_aggregates"
          ? await repairPublicAggregateTrack(client, row.subject_id, options)
          : await repairArtistQualificationTrack(client, row.subject_id, options);
      repaired += changed ? 1 : 0;
      if (attempted >= limit) {
        return { fanout: 0, repaired };
      }
    }
  }
  while (attempted < limit && options.projection !== "public_aggregates") {
    const artist = await firstRepairOfType(client, "artist_qualification", "artist");
    if (artist === undefined) {
      break;
    }
    attempted += 1;
    repaired += (await repairArtistQualificationById(client, artist, options)) ? 1 : 0;
  }
  return { fanout: 0, repaired };
}

async function projectionStateRow(
  client: PublicProjectionClient,
  projection: PublicProjectionName,
): Promise<PublicProjectionRebuildCheckpoint | undefined> {
  const result =
    projection === "public_aggregates"
      ? await client.execute(`select completed_at, cursor, generation, projected_entry_count as projected_count,
          projected_digest, rebuild_start_epoch, scanned_count, source_entry_count as source_count,
          source_digest, source_epoch, started_at, state, updated_at
        from public_aggregate_state where scope = 'tracks'`)
      : await client.execute(`select completed_at, cursor, generation,
          projected_qualified_count as projected_count, projected_digest, rebuild_start_epoch,
          scanned_count, source_qualified_count as source_count, source_digest, source_epoch,
          started_at, state, updated_at
        from artist_qualification_state where scope = 'artists'`);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) {
    return undefined;
  }
  const state = row["state"];
  if (state !== "complete" && state !== "running") {
    throw new Error(`invalid ${projection} rebuild state`);
  }
  return {
    completedAt: (row["completed_at"] as null | string) ?? null,
    cursor: (row["cursor"] as null | string) ?? null,
    generation: String(row["generation"]),
    projectedCount: Number(row["projected_count"]),
    projectedDigest: (row["projected_digest"] as null | string) ?? null,
    projection,
    rebuildStartEpoch: Number(row["rebuild_start_epoch"]),
    scannedCount: Number(row["scanned_count"]),
    sourceCount: Number(row["source_count"]),
    sourceDigest: (row["source_digest"] as null | string) ?? null,
    sourceEpoch: Number(row["source_epoch"]),
    startedAt: String(row["started_at"]),
    state,
    updatedAt: String(row["updated_at"]),
  };
}

export async function startPublicProjectionRebuild(
  client: PublicProjectionClient,
  projection: PublicProjectionName,
  options: { generation?: string; newGeneration?: boolean; now?: () => Date } = {},
): Promise<PublicProjectionRebuildCheckpoint> {
  await ensurePublicProjectionState(client, options);
  const existing = await projectionStateRow(client, projection);
  const now = nowIso(options.now);
  const generation = options.generation ?? crypto.randomUUID();
  if (generation === PUBLIC_PROJECTION_LIVE_GENERATION) {
    throw new Error("public projection rebuild generation 'live' is reserved for repairs");
  }
  const restart =
    options.newGeneration === true || existing?.generation === PUBLIC_PROJECTION_LIVE_GENERATION
      ? 1
      : 0;
  const statement: PublicProjectionStatement =
    projection === "public_aggregates"
      ? {
          args: [generation, now, now, restart],
          sql: `update public_aggregate_state
            set generation = ?, cursor = null, scanned_count = 0, source_entry_count = 0,
                projected_entry_count = 0, rebuild_start_epoch = source_epoch,
                release_hub_order_epoch = release_hub_order_epoch + 1,
                state = 'running', started_at = ?, updated_at = ?, completed_at = null,
                source_digest = null, projected_digest = null
            where scope = 'tracks' and ? = 1`,
        }
      : {
          args: [generation, now, now, restart],
          sql: `update artist_qualification_state
            set generation = ?, cursor = null, scanned_count = 0, source_qualified_count = 0,
                projected_qualified_count = 0, rebuild_start_epoch = source_epoch,
                state = 'running', started_at = ?, updated_at = ?, completed_at = null,
                source_digest = null, projected_digest = null
            where scope = 'artists' and ? = 1`,
        };
  await client.execute(statement);
  const current = await projectionStateRow(client, projection);
  if (current === undefined) {
    throw new Error(`${projection} rebuild state disappeared`);
  }
  return current;
}

async function readSortedTrackIds(
  client: PublicProjectionClient,
  after: null | string,
  limit: number,
): Promise<string[]> {
  const result = await client.execute({
    args: [after ?? "", limit],
    sql: `select track_id from tracks where track_id > ? order by track_id limit ?`,
  });
  return (result.rows as unknown as { track_id: string }[]).map((row) => row.track_id);
}

async function aggregateDigests(client: PublicProjectionClient): Promise<{
  projectedCount: number;
  projectedDigest: string;
  sourceCount: number;
  sourceDigest: string;
}> {
  const [
    sourceMembership,
    projectedMembership,
    sourceCounts,
    projectedCounts,
    sourceTotal,
    projectedTotal,
  ] = await Promise.all([
    client.execute(`select track_id, substr(release_date, 1, 4) as release_date_bucket,
          key as key_bucket from tracks order by track_id`),
    client.execute(`select track_id, release_date_bucket, key_bucket
          from public_aggregate_membership order by track_id`),
    client.execute(`select aggregate_kind, bucket, count(*) as track_count from (
          select 'release_date_bucket' as aggregate_kind,
                 substr(release_date, 1, 4) as bucket from tracks where release_date is not null
          union all
          select 'key' as aggregate_kind, key as bucket from tracks where key is not null
        ) group by aggregate_kind, bucket order by aggregate_kind, bucket`),
    client.execute(`select aggregate_kind, bucket, track_count
          from public_aggregate_counts order by aggregate_kind, bucket`),
    client.execute(`select count(*) as total from tracks`),
    client.execute(`select default_track_total as total from public_aggregate_state
          where scope = 'tracks'`),
  ]);
  const sourceRows = [
    ["total", Number(sourceTotal.rows[0]?.total ?? 0)],
    ...sourceCounts.rows.map((row) => [
      "count",
      row.aggregate_kind,
      row.bucket,
      Number(row.track_count),
    ]),
    ...sourceMembership.rows.map((row) => [
      "track",
      row.track_id,
      row.release_date_bucket,
      row.key_bucket,
    ]),
  ];
  const projectedRows = [
    ["total", Number(projectedTotal.rows[0]?.total ?? 0)],
    ...projectedCounts.rows.map((row) => [
      "count",
      row.aggregate_kind,
      row.bucket,
      Number(row.track_count),
    ]),
    ...projectedMembership.rows.map((row) => [
      "track",
      row.track_id,
      row.release_date_bucket,
      row.key_bucket,
    ]),
  ];
  return {
    projectedCount: projectedMembership.rows.length,
    projectedDigest: digestRows(projectedRows),
    sourceCount: sourceMembership.rows.length,
    sourceDigest: digestRows(sourceRows),
  };
}

async function artistDigests(client: PublicProjectionClient): Promise<{
  projectedCount: number;
  projectedDigest: string;
  sourceCount: number;
  sourceDigest: string;
}> {
  const [sourceContributions, projectedContributions, sourceArtists, projectedArtists] =
    await Promise.all([
      client.execute(`select ta.track_id, ta.artist_id,
          case when f.track_id is null then 0 else 1 end as certified_contribution,
          case when l.seed_state = 'enabled'
            then case when ta.role = 'remixer' then 1 else 2 end else 0 end
            as enabled_credit_half_units
        from track_artists ta
        join tracks t on t.track_id = ta.track_id
        left join findings f on f.track_id = ta.track_id
        left join labels l on l.id = t.label_id
        order by ta.track_id, ta.artist_id`),
      client.execute(`select track_id, artist_id, certified_contribution,
          enabled_credit_half_units from artist_qualification_contributions
        order by track_id, artist_id`),
      client.execute(`select ta.artist_id,
          count(case when f.track_id is not null then 1 end) as certified_finding_count,
          coalesce(sum(case when l.seed_state = 'enabled'
            then case when ta.role = 'remixer' then 1 else 2 end else 0 end), 0)
            as enabled_credit_half_units
        from track_artists ta
        join tracks t on t.track_id = ta.track_id
        left join findings f on f.track_id = ta.track_id
        left join labels l on l.id = t.label_id
        group by ta.artist_id
        order by ta.artist_id`),
      client.execute(`select artist_id, certified_finding_count, enabled_credit_half_units,
          is_qualified from artist_qualification order by artist_id`),
    ]);
  const sourceRows = [
    ...sourceContributions.rows.map((row) => [
      "contribution",
      row.track_id,
      row.artist_id,
      Number(row.certified_contribution),
      Number(row.enabled_credit_half_units),
    ]),
    ...sourceArtists.rows
      .filter(
        (row) =>
          Number(row.certified_finding_count) > 0 || Number(row.enabled_credit_half_units) > 0,
      )
      .map((row) => [
        "artist",
        row.artist_id,
        Number(row.certified_finding_count),
        Number(row.enabled_credit_half_units),
        Number(row.certified_finding_count) > 0 || Number(row.enabled_credit_half_units) >= 6
          ? 1
          : 0,
      ]),
  ];
  const projectedRows = [
    ...projectedContributions.rows.map((row) => [
      "contribution",
      row.track_id,
      row.artist_id,
      Number(row.certified_contribution),
      Number(row.enabled_credit_half_units),
    ]),
    ...projectedArtists.rows.map((row) => [
      "artist",
      row.artist_id,
      Number(row.certified_finding_count),
      Number(row.enabled_credit_half_units),
      Number(row.is_qualified),
    ]),
  ];
  const sourceQualifiedCount = sourceArtists.rows.filter(
    (row) => Number(row.certified_finding_count) > 0 || Number(row.enabled_credit_half_units) >= 6,
  ).length;
  const projectedQualifiedCount = projectedArtists.rows.filter(
    (row) => Number(row.is_qualified) === 1,
  ).length;
  return {
    projectedCount: projectedQualifiedCount,
    projectedDigest: digestRows(projectedRows),
    sourceCount: sourceQualifiedCount,
    sourceDigest: digestRows(sourceRows),
  };
}

export type PublicProjectionAuditLane =
  | "aggregate_projected_anchors"
  | "aggregate_projected_counts"
  | "aggregate_projected_membership"
  | "aggregate_source_anchors"
  | "aggregate_source_membership"
  | "artist_projected_contributions"
  | "artist_projected_rollups"
  | "artist_source_contributions"
  | "artist_source_rollups";

function pairCursor(value: null | string): [string, string] {
  if (value === null) {
    return ["", ""];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed.every((item) => typeof item === "string")
      ? [parsed[0] as string, parsed[1] as string]
      : ["", ""];
  } catch {
    return ["", ""];
  }
}

function anchorSourceCursor(value: null | string): TrackAnchorSourceCursor & { position: number } {
  if (value === null) {
    return { id: null, key: null, phase: "non_null", position: 0 };
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("malformed anchor audit cursor");
    }
    const state = parsed as Record<string, unknown>;
    if (Object.keys(state).sort().join(",") !== "id,key,phase,position") {
      throw new Error("malformed anchor audit cursor");
    }
    const id = state["id"];
    const key = state["key"];
    const phase = state["phase"];
    const position = state["position"];
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      (phase !== "non_null" && phase !== "null") ||
      (phase === "non_null" && typeof key !== "string") ||
      (phase === "null" && key !== null) ||
      typeof position !== "number" ||
      !Number.isSafeInteger(position) ||
      position <= 0
    ) {
      throw new Error("malformed anchor audit cursor");
    }
    return { id, key: phase === "null" ? null : (key as string), phase, position };
  } catch {
    throw new Error("malformed anchor audit cursor");
  }
}

type PublicCleanupState = {
  cursor: null | string;
  phase: "contributions" | "membership" | "qualification";
};

function parsePublicCleanupState(
  value: unknown,
  projection: PublicProjectionName,
): PublicCleanupState {
  if (typeof value !== "string") {
    throw new Error("missing cleanup cursor");
  }
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("malformed cleanup cursor");
  }
  const candidate = parsed as Record<string, unknown>;
  const cursor = candidate["cursor"];
  const phase = candidate["phase"];
  if (
    (cursor !== null && typeof cursor !== "string") ||
    (phase !== "contributions" && phase !== "membership" && phase !== "qualification") ||
    (projection === "public_aggregates" && phase !== "membership") ||
    (projection === "artist_qualification" && phase === "membership")
  ) {
    throw new Error("malformed cleanup cursor");
  }
  return { cursor, phase };
}

/** One bounded canonical audit page. The operator control plane owns durable cursors/digests. */
export async function readPublicProjectionAuditChunk(
  client: PublicProjectionClient,
  lane: PublicProjectionAuditLane,
  options: { cursor: null | string; limit: number },
): Promise<{ complete?: boolean; cursor: null | string; rows: unknown[][]; scanned: number }> {
  assertLimit(options.limit);
  if (lane === "aggregate_source_anchors") {
    const after = anchorSourceCursor(options.cursor);
    const page = await readTrackAnchorSourcePage(client, after, options.limit);
    const rows = page.rows;
    const boundaries = rows.flatMap((row, index) => {
      const position = after.position + index + 1;
      return position % TRACKS_HUB_PAGE_SIZE === 0
        ? [["anchor", row.track_id, row.release_date, position / TRACKS_HUB_PAGE_SIZE + 1]]
        : [];
    });
    return {
      complete: page.complete,
      cursor: page.complete
        ? null
        : JSON.stringify({ ...page.cursor, position: after.position + rows.length }),
      rows: boundaries,
      scanned: rows.length,
    };
  }
  if (lane === "aggregate_projected_anchors") {
    const [clauseHash, itemIndex] = pairCursor(options.cursor);
    const result = await client.execute({
      args: [
        TRACKS_HUB_ANCHOR_ADDRESS.hub,
        TRACKS_HUB_ANCHOR_ADDRESS.clauseHash,
        clauseHash,
        clauseHash,
        Number(itemIndex || -1),
        options.limit,
      ],
      sql: `select shard.clause_hash, cast(item.key as integer) as item_index,
          json_extract(item.value, '$.id') as anchor_id,
          json_extract(item.value, '$.key') as anchor_key,
          json_extract(item.value, '$.page') as anchor_page
        from public_aggregate_state aggregate
        join hub_page_anchor_validity validity
          on validity.hub = ? and validity.clause_hash = ?
         and validity.generation = aggregate.generation
         and validity.order_epoch = aggregate.release_hub_order_epoch
        join hub_page_anchors shard
          on shard.hub = validity.hub
         and shard.clause_hash >= validity.clause_hash || ':' || validity.generation || ':'
         and shard.clause_hash < validity.clause_hash || ':' || validity.generation || ':\uffff'
        join json_each(case when json_valid(shard.anchors_json)
          and json_type(case when json_valid(shard.anchors_json)
            then shard.anchors_json else 'null' end) = 'array'
          then shard.anchors_json else '[]' end) item
        where aggregate.scope = 'tracks'
          and (shard.clause_hash > ?
            or (shard.clause_hash = ? and cast(item.key as integer) > ?))
        order by shard.clause_hash, cast(item.key as integer) limit ?`,
    });
    const terminal = result.rows.at(-1);
    const terminalItemIndex = Number(terminal?.item_index);
    return {
      cursor:
        typeof terminal?.clause_hash === "string" && Number.isSafeInteger(terminalItemIndex)
          ? JSON.stringify([terminal.clause_hash, String(terminalItemIndex)])
          : null,
      rows: result.rows.map((row) => [
        "anchor",
        row.anchor_id,
        row.anchor_key,
        Number(row.anchor_page),
      ]),
      scanned: result.rows.length,
    };
  }
  if (lane === "aggregate_source_membership" || lane === "aggregate_projected_membership") {
    const source = lane === "aggregate_source_membership";
    const result = await client.execute({
      args: [options.cursor ?? "", options.limit],
      sql: source
        ? `select track_id, substr(release_date, 1, 4) as release_date_bucket, key as key_bucket
          from tracks where track_id > ? order by track_id limit ?`
        : `select track_id, release_date_bucket, key_bucket from public_aggregate_membership
          where track_id > ? order by track_id limit ?`,
    });
    return {
      cursor:
        typeof result.rows.at(-1)?.track_id === "string"
          ? (result.rows.at(-1)?.track_id as string)
          : null,
      rows: result.rows.map((row) => [
        "track",
        row.track_id,
        row.release_date_bucket,
        row.key_bucket,
      ]),
      scanned: result.rows.length,
    };
  }
  if (lane === "aggregate_projected_counts") {
    const [kind, bucket] = pairCursor(options.cursor);
    const result = await client.execute({
      args: [kind, kind, bucket, options.limit],
      sql: `select aggregate_kind, bucket, track_count from public_aggregate_counts
        where aggregate_kind > ? or (aggregate_kind = ? and bucket > ?)
        order by aggregate_kind, bucket limit ?`,
    });
    const terminal = result.rows.at(-1);
    return {
      cursor:
        typeof terminal?.aggregate_kind === "string" && typeof terminal.bucket === "string"
          ? JSON.stringify([terminal.aggregate_kind, terminal.bucket])
          : null,
      rows: result.rows.map((row) => [
        "count",
        row.aggregate_kind,
        row.bucket,
        Number(row.track_count),
      ]),
      scanned: result.rows.length,
    };
  }

  const source = lane.startsWith("artist_source_");
  const contributions = lane.endsWith("contributions");
  if (contributions) {
    const [trackId, artistId] = pairCursor(options.cursor);
    const result = await client.execute({
      args: [trackId, artistId, options.limit],
      sql: source
        ? `select ta.track_id, ta.artist_id,
            case when f.track_id is null then 0 else 1 end as certified_contribution,
            case when l.seed_state = 'enabled'
              then case when ta.role = 'remixer' then 1 else 2 end else 0 end
              as enabled_credit_half_units
          from track_artists ta join tracks t on t.track_id = ta.track_id
          left join findings f on f.track_id = ta.track_id left join labels l on l.id = t.label_id
          where (ta.track_id, ta.artist_id) > (?, ?)
          order by ta.track_id, ta.artist_id limit ?`
        : `select track_id, artist_id, certified_contribution, enabled_credit_half_units
          from artist_qualification_contributions where (track_id, artist_id) > (?, ?)
          order by track_id, artist_id limit ?`,
    });
    const terminal = result.rows.at(-1);
    return {
      cursor:
        typeof terminal?.track_id === "string" && typeof terminal.artist_id === "string"
          ? JSON.stringify([terminal.track_id, terminal.artist_id])
          : null,
      rows: result.rows.map((row) => [
        "contribution",
        row.track_id,
        row.artist_id,
        Number(row.certified_contribution),
        Number(row.enabled_credit_half_units),
      ]),
      scanned: result.rows.length,
    };
  }

  const result = await client.execute({
    args: [options.cursor ?? "", options.limit],
    sql: source
      ? `with page as (select id from artists where id > ? order by id limit ?)
        select page.id as artist_id,
          count(case when f.track_id is not null then 1 end) as certified_finding_count,
          coalesce(sum(case when l.seed_state = 'enabled'
            then case when ta.role = 'remixer' then 1 else 2 end else 0 end), 0)
            as enabled_credit_half_units
        from page left join track_artists ta on ta.artist_id = page.id
        left join tracks t on t.track_id = ta.track_id left join findings f on f.track_id = ta.track_id
        left join labels l on l.id = t.label_id group by page.id order by page.id`
      : `select artist_id, certified_finding_count, enabled_credit_half_units, is_qualified
        from artist_qualification where artist_id > ? order by artist_id limit ?`,
  });
  const filtered = source
    ? result.rows.filter(
        (row) =>
          Number(row.certified_finding_count) > 0 || Number(row.enabled_credit_half_units) > 0,
      )
    : result.rows;
  return {
    cursor:
      typeof result.rows.at(-1)?.artist_id === "string"
        ? (result.rows.at(-1)?.artist_id as string)
        : null,
    rows: filtered.map((row) => [
      "artist",
      row.artist_id,
      Number(row.certified_finding_count),
      Number(row.enabled_credit_half_units),
      source
        ? Number(row.certified_finding_count) > 0 || Number(row.enabled_credit_half_units) >= 6
          ? 1
          : 0
        : Number(row.is_qualified),
    ]),
    scanned: result.rows.length,
  };
}

async function finishAggregateRebuild(
  client: PublicProjectionClient,
  checkpoint: PublicProjectionRebuildCheckpoint,
  now: string,
): Promise<void> {
  await client.batch(
    [
      {
        args: [checkpoint.generation, checkpoint.startedAt],
        sql: `delete from public_aggregate_membership
          where generation <> ? and (generation <> '${PUBLIC_PROJECTION_LIVE_GENERATION}'
            or updated_at < ?)`,
      },
      { args: [], sql: `delete from public_aggregate_counts` },
      {
        args: [checkpoint.generation, now, now],
        sql: `insert into public_aggregate_counts
          (aggregate_kind, bucket, track_count, generation, source_version, updated_at)
          select 'release_date_bucket', release_date_bucket, count(*), ?, ?, ?
          from public_aggregate_membership where release_date_bucket is not null
          group by release_date_bucket`,
      },
      {
        args: [checkpoint.generation, now, now],
        sql: `insert into public_aggregate_counts
          (aggregate_kind, bucket, track_count, generation, source_version, updated_at)
          select 'key', key_bucket, count(*), ?, ?, ?
          from public_aggregate_membership where key_bucket is not null group by key_bucket`,
      },
      {
        args: [now, checkpoint.generation],
        sql: `update public_aggregate_state
          set default_track_total = (select count(*) from public_aggregate_membership), updated_at = ?
          where scope = 'tracks' and generation = ?`,
      },
    ],
    "write",
  );
  const digests = await aggregateDigests(client);
  await client.execute({
    args: [
      now,
      now,
      digests.sourceCount,
      digests.projectedCount,
      digests.sourceDigest,
      digests.projectedDigest,
      checkpoint.generation,
    ],
    sql: `update public_aggregate_state
      set state = 'complete', completed_at = ?, updated_at = ?, source_entry_count = ?,
          projected_entry_count = ?, source_digest = ?, projected_digest = ?,
          aggregate_epoch = rebuild_start_epoch
      where scope = 'tracks' and generation = ? and state = 'running'`,
  });
}

async function finishArtistRebuild(
  client: PublicProjectionClient,
  checkpoint: PublicProjectionRebuildCheckpoint,
  now: string,
): Promise<void> {
  await client.batch(
    [
      {
        args: [checkpoint.generation, checkpoint.startedAt],
        sql: `delete from artist_qualification_contributions
          where generation <> ? and (generation <> '${PUBLIC_PROJECTION_LIVE_GENERATION}'
            or updated_at < ?)`,
      },
      { args: [], sql: `delete from artist_qualification` },
      {
        args: [checkpoint.generation, now, now],
        sql: `insert into artist_qualification
          (artist_id, certified_finding_count, enabled_credit_half_units, is_qualified,
           generation, source_version, updated_at)
          select artist_id, sum(certified_contribution), sum(enabled_credit_half_units),
                 case when sum(certified_contribution) > 0
                    or sum(enabled_credit_half_units) >= 6 then 1 else 0 end,
                 ?, ?, ?
          from artist_qualification_contributions
          group by artist_id
          having sum(certified_contribution) > 0 or sum(enabled_credit_half_units) > 0`,
      },
    ],
    "write",
  );
  const digests = await artistDigests(client);
  await client.execute({
    args: [
      now,
      now,
      digests.sourceCount,
      digests.projectedCount,
      digests.sourceDigest,
      digests.projectedDigest,
      checkpoint.generation,
    ],
    sql: `update artist_qualification_state
      set state = 'complete', completed_at = ?, updated_at = ?, source_qualified_count = ?,
          projected_qualified_count = ?, source_digest = ?, projected_digest = ?,
          projection_epoch = rebuild_start_epoch
      where scope = 'artists' and generation = ? and state = 'running'`,
  });
}

export async function runPublicProjectionRebuildChunk(
  client: PublicProjectionClient,
  projection: PublicProjectionName,
  options: {
    boundedCleanup?: boolean;
    generation?: string;
    limit?: number;
    newGeneration?: boolean;
    now?: () => Date;
  } = {},
): Promise<{ checkpoint: PublicProjectionRebuildCheckpoint; complete: boolean; scanned: number }> {
  const limit = options.limit ?? 100;
  assertLimit(limit);
  const checkpoint = await startPublicProjectionRebuild(client, projection, options);
  if (checkpoint.state === "complete") {
    return { checkpoint, complete: true, scanned: 0 };
  }
  const trackIds = await readSortedTrackIds(client, checkpoint.cursor, limit);
  const now = nowIso(options.now);
  if (trackIds.length === 0 && options.boundedCleanup === true) {
    const cleanupKey = `projection_cleanup_${projection}_v1:${checkpoint.generation}`;
    const saved = await client.execute({
      args: [cleanupKey],
      sql: `select value from settings where key = ? limit 1`,
    });
    let cleanup: PublicCleanupState;
    try {
      cleanup = parsePublicCleanupState(saved.rows[0]?.value, projection);
    } catch {
      cleanup = {
        cursor: null,
        phase: projection === "public_aggregates" ? "membership" : "contributions",
      };
    }
    let scanned = 0;
    let cleanupComplete = false;
    if (projection === "public_aggregates") {
      const page = await client.execute({
        args: [cleanup.cursor ?? "", limit],
        sql: `select generation, track_id, updated_at from public_aggregate_membership
          where track_id > ? order by track_id limit ?`,
      });
      const pageRows = page.rows as unknown as {
        generation: string;
        track_id: string;
        updated_at: string;
      }[];
      scanned = pageRows.length;
      const staleTrackIds = pageRows
        .filter(
          (row) =>
            row.generation !== checkpoint.generation &&
            (row.generation !== PUBLIC_PROJECTION_LIVE_GENERATION ||
              row.updated_at < checkpoint.startedAt),
        )
        .map((row) => row.track_id);
      for (const trackId of staleTrackIds) {
        await repairPublicAggregateTrackProjection(client, trackId, {
          generation: checkpoint.generation,
          now,
          preserveAfter: checkpoint.startedAt,
        });
      }
      cleanup.cursor = pageRows.at(-1)?.track_id ?? null;
      cleanupComplete = pageRows.length === 0;
    } else {
      if (cleanup.phase === "contributions") {
        const [afterTrack, afterArtist] = pairCursor(cleanup.cursor);
        const page = await client.execute({
          args: [afterTrack, afterArtist, limit],
          sql: `select artist_id, generation, track_id, updated_at
            from artist_qualification_contributions
            where (track_id, artist_id) > (?, ?) order by track_id, artist_id limit ?`,
        });
        const pageRows = page.rows as unknown as {
          artist_id: string;
          generation: string;
          track_id: string;
          updated_at: string;
        }[];
        scanned = pageRows.length;
        const staleTrackIds = [
          ...new Set(
            pageRows
              .filter(
                (row) =>
                  row.generation !== checkpoint.generation &&
                  (row.generation !== PUBLIC_PROJECTION_LIVE_GENERATION ||
                    row.updated_at < checkpoint.startedAt),
              )
              .map((row) => row.track_id),
          ),
        ];
        for (const trackId of staleTrackIds) {
          const source = await readTrackProjectionSource(client, trackId);
          await repairArtistContributionTrackProjection(client, trackId, {
            generation: checkpoint.generation,
            now,
            preserveAfter: checkpoint.startedAt,
            sourceVersion:
              source?.sourceVersion ?? publicTrackSourceVersion({ key: null, releaseDate: null }),
          });
        }
        const terminal = pageRows.at(-1);
        cleanup.cursor =
          terminal === undefined ? null : JSON.stringify([terminal.track_id, terminal.artist_id]);
        if (pageRows.length === 0) {
          cleanup = { cursor: null, phase: "qualification" };
        }
      } else {
        const page = await client.execute({
          args: [cleanup.cursor ?? "", limit],
          sql: `select artist_id, generation, updated_at from artist_qualification
            where artist_id > ? order by artist_id limit ?`,
        });
        const pageRows = page.rows as unknown as {
          artist_id: string;
          generation: string;
          updated_at: string;
        }[];
        scanned = pageRows.length;
        const artistIds = pageRows
          .filter(
            (row) =>
              row.generation !== checkpoint.generation &&
              (row.generation !== PUBLIC_PROJECTION_LIVE_GENERATION ||
                row.updated_at < checkpoint.startedAt),
          )
          .map((row) => row.artist_id);
        if (artistIds.length > 0) {
          const placeholders = artistIds.map(() => "?").join(", ");
          await client.execute({
            args: [
              ...artistIds,
              checkpoint.generation,
              checkpoint.startedAt,
              checkpoint.generation,
              checkpoint.cursor,
            ],
            sql: `delete from artist_qualification where artist_id in (${placeholders})
              and generation <> ? and (generation <> '${PUBLIC_PROJECTION_LIVE_GENERATION}'
                or updated_at < ?)
              and not exists (select 1 from artist_qualification_contributions contribution
                where contribution.artist_id = artist_qualification.artist_id)
              and exists (select 1 from artist_qualification_state where scope = 'artists'
                and generation = ? and state = 'running' and cursor is ?)`,
          });
        }
        cleanup.cursor = pageRows.at(-1)?.artist_id ?? null;
        cleanupComplete = pageRows.length === 0;
      }
    }

    if (cleanupComplete) {
      await client.execute({ args: [cleanupKey], sql: `delete from settings where key = ?` });
      const completionArgs = [
        now,
        now,
        "0".repeat(64),
        "0".repeat(64),
        checkpoint.generation,
        checkpoint.cursor,
      ];
      if (projection === "public_aggregates") {
        await client.execute({
          args: completionArgs,
          sql: `update public_aggregate_state
            set state = 'complete', completed_at = ?, updated_at = ?,
                source_digest = ?, projected_digest = ?, aggregate_epoch = rebuild_start_epoch
            where scope = 'tracks' and generation = ? and state = 'running' and cursor is ?`,
        });
      } else {
        await client.execute({
          args: completionArgs,
          sql: `update artist_qualification_state
            set state = 'complete', completed_at = ?, updated_at = ?,
                source_digest = ?, projected_digest = ?, projection_epoch = rebuild_start_epoch
            where scope = 'artists' and generation = ? and state = 'running' and cursor is ?`,
        });
      }
    } else {
      await client.execute({
        args: [cleanupKey, JSON.stringify(cleanup)],
        sql: `insert into settings (key, value) values (?, ?)
          on conflict(key) do update set value = excluded.value`,
      });
    }
    const current = await projectionStateRow(client, projection);
    if (current === undefined) {
      throw new Error(`${projection} rebuild state disappeared`);
    }
    return { checkpoint: current, complete: current.state === "complete", scanned };
  }
  for (const trackId of trackIds) {
    if (projection === "public_aggregates") {
      await repairPublicAggregateTrackProjection(client, trackId, {
        generation: checkpoint.generation,
        now,
        preserveAfter: checkpoint.startedAt,
      });
    } else {
      const source = await readTrackProjectionSource(client, trackId);
      await repairArtistContributionTrackProjection(client, trackId, {
        generation: checkpoint.generation,
        now,
        preserveAfter: checkpoint.startedAt,
        sourceVersion:
          source?.sourceVersion ?? publicTrackSourceVersion({ key: null, releaseDate: null }),
      });
    }
  }
  const nextCursor = trackIds.at(-1) ?? checkpoint.cursor;
  const stateTable =
    projection === "public_aggregates" ? "public_aggregate_state" : "artist_qualification_state";
  const scope = projection === "public_aggregates" ? "tracks" : "artists";
  await client.execute({
    args: [nextCursor, trackIds.length, now, checkpoint.generation, checkpoint.cursor],
    sql: `update ${stateTable}
      set cursor = ?, scanned_count = scanned_count + ?, updated_at = ?
      where scope = '${scope}' and generation = ? and state = 'running' and cursor is ?`,
  });
  if (trackIds.length < limit && options.boundedCleanup !== true) {
    if (projection === "public_aggregates") {
      await finishAggregateRebuild(client, checkpoint, now);
    } else {
      await finishArtistRebuild(client, checkpoint, now);
    }
  }
  const current = await projectionStateRow(client, projection);
  if (current === undefined) {
    throw new Error(`${projection} rebuild state disappeared`);
  }
  return { checkpoint: current, complete: current.state === "complete", scanned: trackIds.length };
}

export async function rebuildPublicProjection(
  client: PublicProjectionClient,
  projection: PublicProjectionName,
  options: {
    generation?: string;
    limit?: number;
    maxChunks?: number;
    newGeneration?: boolean;
    now?: () => Date;
  } = {},
): Promise<PublicProjectionRebuildCheckpoint> {
  const maxChunks = options.maxChunks ?? 10_000;
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1) {
    throw new Error("public projection rebuild maxChunks must be a positive integer");
  }
  for (let chunk = 0; chunk < maxChunks; chunk += 1) {
    const result = await runPublicProjectionRebuildChunk(client, projection, {
      ...options,
      newGeneration: chunk === 0 ? options.newGeneration : false,
    });
    if (result.complete) {
      return result.checkpoint;
    }
  }
  throw new Error(`${projection} rebuild exceeded its ${maxChunks}-chunk safety bound`);
}

export async function rebuildDefaultTrackHubAnchors(
  client: PublicProjectionClient,
  options: { generation?: string; now?: () => Date } = {},
): Promise<{ anchors: number; orderEpoch: number }> {
  await ensurePublicProjectionState(client, options);
  const [anchorRows, totalRows, firstRows, state] = await Promise.all([
    client.execute(tracksHubAnchorExtractionQuery({})),
    client.execute(tracksHubCountQuery({})),
    client.execute(tracksHubIdPageQuery({}, 1, 0)),
    client.execute(`select generation, release_hub_order_epoch
      from public_aggregate_state where scope = 'tracks'`),
  ]);
  const stateRow = state.rows[0] as
    | { generation: string; release_hub_order_epoch: number }
    | undefined;
  const anchors = hubPageAnchorsFromRows(
    anchorRows.rows as unknown as Record<string, unknown>[],
    "rd",
    TRACKS_HUB_PAGE_SIZE,
  );
  const orderEpoch = Number(stateRow?.release_hub_order_epoch ?? 0);
  const generation = options.generation ?? stateRow?.generation ?? "anchors";
  const total = Number((totalRows.rows[0] as { total: number } | undefined)?.total ?? 0);
  const firstId = (firstRows.rows[0] as { track_id: string } | undefined)?.track_id;
  const now = nowIso(options.now);
  await client.batch(
    [
      {
        args: [
          TRACKS_HUB_ANCHOR_ADDRESS.hub,
          TRACKS_HUB_ANCHOR_ADDRESS.clauseHash,
          JSON.stringify(anchors),
          hubCorpusFingerprint(total, firstId),
          now,
        ],
        sql: `insert into hub_page_anchors
          (hub, clause_hash, anchors_json, fingerprint, computed_at)
          values (?, ?, ?, ?, ?)
          on conflict(hub, clause_hash) do update set
            anchors_json = excluded.anchors_json, fingerprint = excluded.fingerprint,
            computed_at = excluded.computed_at`,
      },
      {
        args: [
          TRACKS_HUB_ANCHOR_ADDRESS.hub,
          TRACKS_HUB_ANCHOR_ADDRESS.clauseHash,
          PUBLIC_ANCHOR_FORMAT_VERSION,
          orderEpoch,
          generation,
          now,
        ],
        sql: `insert into hub_page_anchor_validity
          (hub, clause_hash, anchor_format_version, order_epoch, generation, published_at)
          values (?, ?, ?, ?, ?, ?)
          on conflict(hub, clause_hash) do update set
            anchor_format_version = excluded.anchor_format_version,
            order_epoch = excluded.order_epoch, generation = excluded.generation,
            published_at = excluded.published_at`,
      },
    ],
    "write",
  );
  return { anchors: anchors.length, orderEpoch };
}

async function enqueueAuditTrackRepair(
  client: PublicProjectionClient,
  trackId: string,
  sourceVersion: string,
  now: string,
): Promise<void> {
  await client.batch(
    [
      { args: [], sql: `select 1` },
      ...markPublicTrackSourceChangedStatements(trackId, sourceVersion, {
        now,
        onlyIfPreviousStatementChanged: false,
      }),
    ],
    "write",
  );
}

async function enqueueAuditArtistRepair(
  client: PublicProjectionClient,
  artistId: string,
  sourceVersion: string,
  now: string,
): Promise<void> {
  await client.batch(
    [
      { args: [], sql: `select 1` },
      ...markArtistQualificationRepairStatements(artistId, sourceVersion, {
        now,
        onlyIfPreviousStatementChanged: false,
      }),
    ],
    "write",
  );
}

export async function auditPublicProjections(
  client: PublicProjectionClient,
  options: { now?: () => Date; repairLimit?: number } = {},
): Promise<PublicProjectionAudit> {
  const repairLimit = options.repairLimit ?? 0;
  if (
    !Number.isSafeInteger(repairLimit) ||
    repairLimit < 0 ||
    repairLimit > MAX_PUBLIC_PROJECTION_CHUNK_SIZE
  ) {
    throw new Error(
      `public audit repair limit must be from 0 through ${MAX_PUBLIC_PROJECTION_CHUNK_SIZE}`,
    );
  }
  const [aggregates, artists] = await Promise.all([
    aggregateDigests(client),
    artistDigests(client),
  ]);
  const scheduledTrackRepairs: string[] = [];
  const scheduledArtistRepairs: string[] = [];
  const now = nowIso(options.now);

  if (aggregates.sourceDigest !== aggregates.projectedDigest && repairLimit > 0) {
    const mismatches = await client.execute({
      args: [repairLimit],
      sql: `select t.track_id, t.release_date, t.key
        from tracks t
        left join public_aggregate_membership pam on pam.track_id = t.track_id
        where pam.track_id is null
          or pam.release_date_bucket is not substr(t.release_date, 1, 4)
          or pam.key_bucket is not t.key
        order by t.track_id limit ?`,
    });
    for (const row of mismatches.rows as unknown as {
      key: null | string;
      release_date: null | string;
      track_id: string;
    }[]) {
      const trackId = row.track_id;
      scheduledTrackRepairs.push(trackId);
      await enqueueAuditTrackRepair(
        client,
        trackId,
        publicTrackSourceVersion({
          key: (row.key as null | string) ?? null,
          releaseDate: (row.release_date as null | string) ?? null,
        }),
        now,
      );
    }
    if (scheduledTrackRepairs.length < repairLimit) {
      const unexpected = await client.execute({
        args: [repairLimit - scheduledTrackRepairs.length],
        sql: `select pam.track_id from public_aggregate_membership pam
          where not exists (select 1 from tracks t where t.track_id = pam.track_id)
          order by pam.track_id limit ?`,
      });
      for (const row of unexpected.rows as unknown as { track_id: string }[]) {
        const trackId = row.track_id;
        scheduledTrackRepairs.push(trackId);
        await enqueueAuditTrackRepair(client, trackId, `audit:${trackId}`, now);
      }
    }

    // Membership repairs run first because their old-to-new deltas assume the stored rollup still
    // describes the old memberships. Once membership is exact, correct a bounded bucket page (and
    // the singleton total) directly; replaying an unchanged track cannot repair a corrupted count.
    if (scheduledTrackRepairs.length === 0) {
      const [expectedCounts, actualCounts] = await Promise.all([
        client.execute(`select aggregate_kind, bucket, count(*) as track_count from (
            select 'release_date_bucket' as aggregate_kind,
                   substr(release_date, 1, 4) as bucket from tracks where release_date is not null
            union all select 'key', key from tracks where key is not null
          ) group by aggregate_kind, bucket order by aggregate_kind, bucket`),
        client.execute(`select aggregate_kind, bucket, track_count
          from public_aggregate_counts order by aggregate_kind, bucket`),
      ]);
      const key = (kind: string, bucket: string) => `${kind}\u0000${bucket}`;
      const expected = new Map(
        (expectedCounts.rows as unknown as AggregateCountRow[]).map((row) => [
          key(row.aggregate_kind, row.bucket),
          {
            bucket: row.bucket,
            count: Number(row.track_count),
            kind: row.aggregate_kind,
          },
        ]),
      );
      const actual = new Map(
        (actualCounts.rows as unknown as AggregateCountRow[]).map((row) => [
          key(row.aggregate_kind, row.bucket),
          {
            bucket: row.bucket,
            count: Number(row.track_count),
            kind: row.aggregate_kind,
          },
        ]),
      );
      let corrected = 0;
      for (const [bucketKey, value] of [...expected, ...actual]) {
        const expectedValue = expected.get(bucketKey);
        const actualValue = actual.get(bucketKey);
        if (expectedValue?.count === actualValue?.count) {
          continue;
        }
        if (expectedValue === undefined) {
          await client.execute({
            args: [value.kind, value.bucket],
            sql: `delete from public_aggregate_counts
              where aggregate_kind = ? and bucket = ?`,
          });
        } else {
          await client.execute({
            args: [
              expectedValue.kind,
              expectedValue.bucket,
              expectedValue.count,
              PUBLIC_PROJECTION_LIVE_GENERATION,
              `audit:${now}`,
              now,
            ],
            sql: `insert into public_aggregate_counts
              (aggregate_kind, bucket, track_count, generation, source_version, updated_at)
              values (?, ?, ?, ?, ?, ?)
              on conflict(aggregate_kind, bucket) do update set
                track_count = excluded.track_count, generation = excluded.generation,
                source_version = excluded.source_version, updated_at = excluded.updated_at`,
          });
        }
        corrected += 1;
        if (corrected >= repairLimit) {
          break;
        }
      }
      if (corrected < repairLimit) {
        await client.execute({
          args: [now],
          sql: `update public_aggregate_state
            set default_track_total = (select count(*) from tracks), updated_at = ?
            where scope = 'tracks'`,
        });
      }
    }
  }

  if (artists.sourceDigest !== artists.projectedDigest && repairLimit > 0) {
    const source = await client.execute(`select ta.track_id, ta.artist_id,
        case when f.track_id is null then 0 else 1 end as certified_contribution,
        case when l.seed_state = 'enabled'
          then case when ta.role = 'remixer' then 1 else 2 end else 0 end
          as enabled_credit_half_units
      from track_artists ta join tracks t on t.track_id = ta.track_id
      left join findings f on f.track_id = ta.track_id left join labels l on l.id = t.label_id
      order by ta.track_id, ta.artist_id`);
    const projected = await client.execute(`select track_id, artist_id, certified_contribution,
        enabled_credit_half_units from artist_qualification_contributions
      order by track_id, artist_id`);
    const sourceByKey = new Map(
      (source.rows as unknown as ArtistContributionRow[]).map((row) => [
        `${row.track_id}\u0000${row.artist_id}`,
        [Number(row.certified_contribution), Number(row.enabled_credit_half_units)],
      ]),
    );
    const projectedByKey = new Map(
      (projected.rows as unknown as ArtistContributionRow[]).map((row) => [
        `${row.track_id}\u0000${row.artist_id}`,
        [Number(row.certified_contribution), Number(row.enabled_credit_half_units)],
      ]),
    );
    const trackIds = new Set<string>();
    for (const [key, value] of [...sourceByKey, ...projectedByKey]) {
      const other = sourceByKey.has(key) ? projectedByKey.get(key) : sourceByKey.get(key);
      if (JSON.stringify(value) !== JSON.stringify(other)) {
        trackIds.add(key.split("\u0000")[0] ?? "");
      }
      if (trackIds.size >= repairLimit) {
        break;
      }
    }
    for (const trackId of trackIds) {
      if (!trackId) {
        continue;
      }
      scheduledTrackRepairs.push(trackId);
      await enqueueAuditTrackRepair(client, trackId, `audit:${trackId}`, now);
    }
    if (scheduledTrackRepairs.length < repairLimit) {
      const sourceArtists = await client.execute(`select ta.artist_id,
          count(case when f.track_id is not null then 1 end) as certified,
          coalesce(sum(case when l.seed_state = 'enabled'
            then case when ta.role = 'remixer' then 1 else 2 end else 0 end), 0) as half_units
        from track_artists ta join tracks t on t.track_id = ta.track_id
        left join findings f on f.track_id = ta.track_id left join labels l on l.id = t.label_id
        group by ta.artist_id order by ta.artist_id`);
      const projectedArtists = await client.execute(`select artist_id,
          certified_finding_count as certified, enabled_credit_half_units as half_units
        from artist_qualification order by artist_id`);
      const expected = new Map(
        (sourceArtists.rows as unknown as ArtistCountRow[]).map((row) => [
          row.artist_id,
          [Number(row.certified), Number(row.half_units)],
        ]),
      );
      const actual = new Map(
        (projectedArtists.rows as unknown as ArtistCountRow[]).map((row) => [
          row.artist_id,
          [Number(row.certified), Number(row.half_units)],
        ]),
      );
      for (const [artistId, counts] of [...expected, ...actual]) {
        const other = expected.has(artistId) ? actual.get(artistId) : expected.get(artistId);
        if (JSON.stringify(counts) !== JSON.stringify(other)) {
          scheduledArtistRepairs.push(artistId);
          await enqueueAuditArtistRepair(client, artistId, `audit:${artistId}`, now);
        }
        if (scheduledTrackRepairs.length + scheduledArtistRepairs.length >= repairLimit) {
          break;
        }
      }
    }
  }
  await client.batch(
    [
      {
        args: [
          now,
          aggregates.sourceCount,
          aggregates.projectedCount,
          aggregates.sourceDigest,
          aggregates.projectedDigest,
        ],
        sql: `update public_aggregate_state
          set audited_at = ?, source_entry_count = ?, projected_entry_count = ?,
              source_digest = ?, projected_digest = ?
          where scope = 'tracks' and state = 'complete'`,
      },
      {
        args: [
          now,
          artists.sourceCount,
          artists.projectedCount,
          artists.sourceDigest,
          artists.projectedDigest,
        ],
        sql: `update artist_qualification_state
          set audited_at = ?, source_qualified_count = ?, projected_qualified_count = ?,
              source_digest = ?, projected_digest = ?
          where scope = 'artists' and state = 'complete'`,
      },
    ],
    "write",
  );
  return {
    aggregateProjectionDigest: aggregates.projectedDigest,
    aggregateSourceDigest: aggregates.sourceDigest,
    aggregatesMatched: aggregates.sourceDigest === aggregates.projectedDigest,
    artistMatched: artists.sourceDigest === artists.projectedDigest,
    artistProjectionDigest: artists.projectedDigest,
    artistSourceDigest: artists.sourceDigest,
    scheduledArtistRepairs,
    scheduledTrackRepairs: [...new Set(scheduledTrackRepairs)],
  };
}

export async function shadowPublicProjections(client: PublicProjectionClient): Promise<{
  aggregateBucketsMatched: boolean;
  anchorEpochMatched: boolean;
  anchorOrderMatched: boolean;
  defaultTotalMatched: boolean;
  legacyQualifiedArtistIds: string[];
  matched: boolean;
  projectedQualifiedArtistIds: string[];
  qualifiedArtistsMatched: boolean;
}> {
  const [
    legacyTotal,
    projectedTotal,
    legacyBuckets,
    projectedBuckets,
    legacyQualified,
    projectedQualified,
    expectedAnchors,
    storedAnchors,
    aggregateState,
    anchorValidity,
  ] = await Promise.all([
    client.execute(`select count(*) as total from tracks`),
    client.execute(`select default_track_total as total from public_aggregate_state
        where scope = 'tracks'`),
    client.execute(`select aggregate_kind, bucket, count(*) as track_count from (
          select 'release_date_bucket' as aggregate_kind,
                 substr(release_date, 1, 4) as bucket from tracks where release_date is not null
          union all select 'key', key from tracks where key is not null
        ) group by aggregate_kind, bucket order by aggregate_kind, bucket`),
    client.execute(`select aggregate_kind, bucket, track_count from public_aggregate_counts
        order by aggregate_kind, bucket`),
    client.execute(`select artist_id from (${QUALIFIED_ARTISTS_SQL}) order by artist_id`),
    client.execute(`select artist_id from artist_qualification
        where is_qualified = 1 order by artist_id`),
    client.execute(tracksHubAnchorExtractionQuery({})),
    readStoredTrackHubAnchorsForAudit(client, TRACKS_HUB_ANCHOR_ADDRESS, TRACKS_HUB_PAGE_SIZE),
    client.execute(`select release_hub_order_epoch as order_epoch
      from public_aggregate_state where scope = 'tracks'`),
    client.execute({
      args: [TRACKS_HUB_ANCHOR_ADDRESS.hub, TRACKS_HUB_ANCHOR_ADDRESS.clauseHash],
      sql: `select order_epoch from hub_page_anchor_validity where hub = ? and clause_hash = ?`,
    }),
  ]);
  const defaultTotalMatched =
    Number(legacyTotal.rows[0]?.total ?? 0) === Number(projectedTotal.rows[0]?.total ?? -1);
  const bucketRows = (rows: typeof legacyBuckets.rows) =>
    rows.map((row) => [row.aggregate_kind, row.bucket, Number(row.track_count)]);
  const aggregateBucketsMatched =
    JSON.stringify(bucketRows(legacyBuckets.rows)) ===
    JSON.stringify(bucketRows(projectedBuckets.rows));
  const legacyQualifiedArtistIds = (legacyQualified.rows as unknown as { artist_id: string }[]).map(
    (row) => row.artist_id,
  );
  const projectedQualifiedArtistIds = (
    projectedQualified.rows as unknown as { artist_id: string }[]
  ).map((row) => row.artist_id);
  const expectedAnchorRows = hubPageAnchorsFromRows(
    expectedAnchors.rows as unknown as Record<string, unknown>[],
    "rd",
    TRACKS_HUB_PAGE_SIZE,
  );
  const storedAnchorRows = storedAnchors?.anchors ?? null;
  const anchorOrderMatched =
    JSON.stringify(expectedAnchorRows) === JSON.stringify(storedAnchorRows);
  const anchorEpochMatched =
    Number(aggregateState.rows[0]?.order_epoch ?? -1) ===
    Number(anchorValidity.rows[0]?.order_epoch ?? -2);
  const qualifiedArtistsMatched =
    JSON.stringify(legacyQualifiedArtistIds) === JSON.stringify(projectedQualifiedArtistIds);
  return {
    aggregateBucketsMatched,
    anchorEpochMatched,
    anchorOrderMatched,
    defaultTotalMatched,
    legacyQualifiedArtistIds,
    matched:
      defaultTotalMatched &&
      aggregateBucketsMatched &&
      qualifiedArtistsMatched &&
      anchorOrderMatched &&
      anchorEpochMatched,
    projectedQualifiedArtistIds,
    qualifiedArtistsMatched,
  };
}
