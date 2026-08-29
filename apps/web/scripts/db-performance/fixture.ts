import { createHash } from "node:crypto";

import { type Client, type ResultSet } from "@libsql/client";

import { getScaleManifest, type FixtureCounts, type ScaleProfile } from "./manifest";

export const DEFAULT_FIXTURE_CHUNK_SIZE = 500;
export const FIXTURE_CENSUS_QUERY_CHUNK_SIZE = 8;
export const HOSTED_FIXTURE_CENSUS_ROW_LIMIT = 50_000;
export const SYNTHETIC_FIXTURE_EPOCH = "2026-01-01T00:00:00.000Z";
export const FIXTURE_IDENTITY_TABLE = "perf_fixture_identity";

export const FIXTURE_TABLES = [
  "perf_artists",
  "perf_labels",
  "perf_albums",
  "perf_tracks",
  "perf_due_work",
  "perf_findings",
  "perf_galaxies",
  "perf_track_embeddings",
  "perf_track_artists",
  "perf_crawl_frontier",
  "perf_crawl_due_work",
  "perf_crawl_projection_repairs",
  "perf_artist_qualification",
  "perf_artist_qualification_contributions",
  "perf_artist_qualification_state",
  "perf_public_aggregate_counts",
  "perf_public_aggregate_membership",
  "perf_public_aggregate_state",
  "perf_projection_repairs",
  "perf_hub_page_anchors",
  "perf_hub_page_anchor_validity",
  "due_work",
  "perf_artifact_change_checkpoints",
  "perf_artifact_change_consumers",
  "perf_artifact_changes",
  "perf_artifact_change_revisions",
  "perf_operation_receipts",
  "perf_database_admission_contenders",
] as const;

export type FixtureTable = (typeof FIXTURE_TABLES)[number];
export type FixtureTableCardinalities = Record<FixtureTable, number>;
export type FixtureCensus = {
  distributions: {
    expected: FixtureCounts;
    observed: FixtureCounts;
  };
  mismatches: string[];
  passed: boolean;
  tables: {
    expected: FixtureTableCardinalities;
    observed: FixtureTableCardinalities;
  };
};
export type FixtureCensusOptions = {
  maxRowsPerStatement?: number;
  onRequest?: (request: number, requests: number) => void;
  statementsPerRequest?: number;
};
export type FixtureValue = null | number | string | Uint8Array;
export type FixtureStatement = { args: FixtureValue[]; sql: string };
export type FixtureChunk = { statements: FixtureStatement[]; table: FixtureTable };

export type FixtureBatchSink = {
  batch: (statements: { args: FixtureValue[]; sql: string }[], mode?: "write") => Promise<unknown>;
};

export type GenerateFixtureOptions = {
  chunkSize?: number;
  /** Tests and CI may supply a ratio-preserving derivative. Exact runs omit this field. */
  counts?: FixtureCounts;
};

export const CONTRACT_D_ANCHOR_FORMAT_VERSION = 1;
export const CONTRACT_D_CRAWL_CLAIM_LIMIT = 500;
export const CONTRACT_D_HUB_PAGE_SIZE = 48;
export const CONTRACT_D_QUALIFIED_ARTIST_LIMIT = 6;

type ProjectionBucketDefinition = {
  baselineCount: number;
  bucket: null | string;
};

export type ProjectionBucket = {
  bucket: null | string;
  count: number;
};

export type ProjectionFixtureCardinalities = {
  perf_artist_qualification: number;
  perf_artist_qualification_contributions: number;
  perf_artist_qualification_state: number;
  perf_crawl_due_work: number;
  perf_crawl_projection_repairs: number;
  perf_hub_page_anchor_validity: number;
  perf_hub_page_anchors: number;
  perf_projection_repairs: number;
  perf_public_aggregate_counts: number;
  perf_public_aggregate_membership: number;
  perf_public_aggregate_state: number;
};

export type IndexFixtureCardinalities = {
  perf_artifact_change_checkpoints: number;
  perf_artifact_change_consumers: number;
  perf_artifact_change_revisions: number;
  perf_artifact_changes: number;
  perf_database_admission_contenders: number;
  perf_due_work: number;
  perf_operation_receipts: number;
};

const BASE_TRACK_COUNT = getScaleManifest("1x").counts.tracks;
const RELEASE_BUCKET_DEFINITIONS: ProjectionBucketDefinition[] = [
  { baselineCount: 28_000, bucket: "2026" },
  { baselineCount: 27_000, bucket: "2025" },
  { baselineCount: 24_000, bucket: "2024" },
  { baselineCount: 20_000, bucket: "2023" },
  { baselineCount: 5_000, bucket: "" },
  { baselineCount: 18_151, bucket: null },
];
const KEY_BUCKET_DEFINITIONS: ProjectionBucketDefinition[] = [
  { baselineCount: 30_000, bucket: "C minor" },
  { baselineCount: 25_000, bucket: "D minor" },
  { baselineCount: 20_000, bucket: "F major" },
  { baselineCount: 15_000, bucket: "G minor" },
  { baselineCount: 5_000, bucket: "" },
  { baselineCount: 27_151, bucket: null },
];

function exactProfileMultiplier(total: number): 1 | 2 | 4 | undefined {
  for (const [profile, multiplier] of [
    ["1x", 1],
    ["2x", 2],
    ["4x", 4],
  ] as const) {
    if (total === getScaleManifest(profile).counts.tracks) {
      return multiplier;
    }
  }

  return undefined;
}

function projectionBuckets(
  definitions: readonly ProjectionBucketDefinition[],
  total: number,
): ProjectionBucket[] {
  const multiplier = exactProfileMultiplier(total);
  if (multiplier !== undefined) {
    return definitions.map((definition) => ({
      bucket: definition.bucket,
      count: definition.baselineCount * multiplier,
    }));
  }

  const scale = total / BASE_TRACK_COUNT;
  let assigned = 0;

  return definitions.map((definition, index) => {
    const count =
      index === definitions.length - 1
        ? total - assigned
        : Math.min(total - assigned, Math.max(0, Math.round(definition.baselineCount * scale)));
    assigned += count;

    return { bucket: definition.bucket, count };
  });
}

export function publicAggregateFixtureBuckets(counts: FixtureCounts): {
  key: ProjectionBucket[];
  releaseDate: ProjectionBucket[];
} {
  return {
    key: projectionBuckets(KEY_BUCKET_DEFINITIONS, counts.tracks),
    releaseDate: projectionBuckets(RELEASE_BUCKET_DEFINITIONS, counts.tracks),
  };
}

export function projectionFixtureCardinalities(
  counts: FixtureCounts,
): ProjectionFixtureCardinalities {
  const buckets = publicAggregateFixtureBuckets(counts);

  return {
    perf_artist_qualification: counts.artists,
    perf_artist_qualification_contributions: counts.trackArtists,
    perf_artist_qualification_state: 1,
    perf_crawl_due_work: counts.pendingFrontier + crawlDueWorkLifecycleExtra(counts),
    perf_crawl_projection_repairs: 0,
    perf_hub_page_anchor_validity: 1,
    perf_hub_page_anchors: 1,
    perf_projection_repairs: 1,
    perf_public_aggregate_counts:
      buckets.releaseDate.filter((entry) => entry.bucket !== null).length +
      buckets.key.filter((entry) => entry.bucket !== null).length,
    perf_public_aggregate_membership: counts.tracks,
    perf_public_aggregate_state: 1,
  };
}

export function indexFixtureCardinalities(counts: FixtureCounts): IndexFixtureCardinalities {
  return {
    perf_artifact_change_checkpoints: proportionalIndexCount(counts, 0.1, 16),
    perf_artifact_change_consumers: proportionalIndexCount(counts, 0.02, 8),
    perf_artifact_change_revisions: proportionalIndexCount(counts, 0.12, 16),
    perf_artifact_changes: proportionalIndexCount(counts, 0.12, 16),
    perf_database_admission_contenders: proportionalIndexCount(counts, 0.03, 12, 256),
    perf_due_work: proportionalIndexCount(counts, 0.4, 32),
    perf_operation_receipts: proportionalIndexCount(counts, 0.08, 16),
  };
}

export function expectedFixtureTableCardinalities(
  counts: FixtureCounts,
): FixtureTableCardinalities {
  const indexCounts = indexFixtureCardinalities(counts);
  const projectionCounts = projectionFixtureCardinalities(counts);

  return {
    due_work: counts.youtubeProvenanceBacklog + counts.musicbrainzIsrcBacklog,
    perf_albums: counts.albums,
    perf_artifact_change_checkpoints: indexCounts.perf_artifact_change_checkpoints,
    perf_artifact_change_consumers: indexCounts.perf_artifact_change_consumers,
    perf_artifact_change_revisions: indexCounts.perf_artifact_change_revisions,
    perf_artifact_changes: indexCounts.perf_artifact_changes,
    perf_artist_qualification: projectionCounts.perf_artist_qualification,
    perf_artist_qualification_contributions:
      projectionCounts.perf_artist_qualification_contributions,
    perf_artist_qualification_state: projectionCounts.perf_artist_qualification_state,
    perf_artists: counts.artists,
    perf_crawl_due_work: projectionCounts.perf_crawl_due_work,
    perf_crawl_frontier: counts.crawlFrontier,
    perf_crawl_projection_repairs: projectionCounts.perf_crawl_projection_repairs,
    perf_database_admission_contenders: indexCounts.perf_database_admission_contenders,
    perf_due_work: indexCounts.perf_due_work,
    perf_findings: counts.findings,
    perf_galaxies: 0,
    perf_hub_page_anchor_validity: projectionCounts.perf_hub_page_anchor_validity,
    perf_hub_page_anchors: projectionCounts.perf_hub_page_anchors,
    perf_labels: counts.labels,
    perf_operation_receipts: indexCounts.perf_operation_receipts,
    perf_projection_repairs: projectionCounts.perf_projection_repairs,
    perf_public_aggregate_counts: projectionCounts.perf_public_aggregate_counts,
    perf_public_aggregate_membership: projectionCounts.perf_public_aggregate_membership,
    perf_public_aggregate_state: projectionCounts.perf_public_aggregate_state,
    perf_track_artists: counts.trackArtists,
    perf_track_embeddings: counts.trackEmbeddings,
    perf_tracks: counts.tracks,
  };
}

function proportionalIndexCount(
  counts: FixtureCounts,
  ratio: number,
  minimum: number,
  maximum = Number.POSITIVE_INFINITY,
): number {
  const multiplier = exactProfileMultiplier(counts.tracks);
  const baseline = Math.max(minimum, Math.round(BASE_TRACK_COUNT * ratio));
  const count =
    multiplier === undefined
      ? Math.max(minimum, Math.round(counts.tracks * ratio))
      : baseline * multiplier;

  return Math.min(maximum, count);
}

function crawlDueWorkLifecycleExtra(counts: FixtureCounts): number {
  const multiplier = exactProfileMultiplier(counts.tracks);

  return multiplier === undefined
    ? Math.max(12, Math.round(counts.pendingFrontier * 0.1))
    : 12 * multiplier;
}

function bucketForIndex(index: number, buckets: readonly ProjectionBucket[]): null | string {
  let start = 0;

  for (const entry of buckets) {
    if (index < start + entry.count) {
      return entry.bucket;
    }
    start += entry.count;
  }

  return buckets.at(-1)?.bucket ?? null;
}

export function releaseDateForIndex(
  index: number,
  buckets: readonly ProjectionBucket[],
): null | string {
  let start = 0;

  for (const entry of buckets) {
    if (index >= start + entry.count) {
      start += entry.count;
      continue;
    }

    if (entry.bucket !== "2026" || entry.count < 1) {
      return entry.bucket;
    }

    // Keep the exact release-year histogram while giving the public fresh-window contracts real
    // day-precision rows. Monotonic assignment means release_date DESC, id DESC remains one reverse
    // index walk, including repeated dates at 2x and 4x.
    const dayOffset = Math.floor(((index - start) * 365) / entry.count);
    return new Date(Date.UTC(2026, 0, 1 + dayOffset)).toISOString().slice(0, 10);
  }

  return buckets.at(-1)?.bucket ?? null;
}

function keyForIndex(index: number, buckets: readonly ProjectionBucket[]): null | string {
  return bucketForIndex(index, buckets);
}

function sourceVersionForPublicTrack(releaseDate: null | string, key: null | string): string {
  return JSON.stringify([releaseDate, key]);
}

function syntheticAnchorRows(
  total: number,
  releaseBuckets: readonly ProjectionBucket[],
): { id: string; key: null | string; page: number }[] {
  const anchors: { id: string; key: null | string; page: number }[] = [];
  let rank = 0;

  for (const bucket of releaseBuckets) {
    const firstIndex = releaseBuckets
      .slice(0, releaseBuckets.indexOf(bucket))
      .reduce((sum, entry) => sum + entry.count, 0);
    for (let index = firstIndex + bucket.count - 1; index >= firstIndex; index -= 1) {
      rank += 1;
      if (rank % CONTRACT_D_HUB_PAGE_SIZE === 0) {
        anchors.push({
          id: `synthetic-track-${padded(index)}`,
          key: releaseDateForIndex(index, releaseBuckets),
          page: rank / CONTRACT_D_HUB_PAGE_SIZE + 1,
        });
      }
    }
  }

  return anchors;
}

export function defaultAnchorFixtureRows(counts: FixtureCounts): {
  id: string;
  key: null | string;
  page: number;
}[] {
  return syntheticAnchorRows(counts.tracks, publicAggregateFixtureBuckets(counts).releaseDate);
}

export function defaultAnchorFixtureFingerprint(counts: FixtureCounts): string {
  return `${counts.tracks}:${defaultAnchorFixtureRows(counts)[0]?.id ?? ""}`;
}

export const PERFORMANCE_FIXTURE_SCHEMA = [
  `create table if not exists perf_artists (
    id text primary key,
    name text not null,
    mbid text,
    image_url text,
    image_key text,
    image_state text,
    image_updated_at text,
    renderable_track_count integer not null
  )`,
  `create index if not exists perf_artists_mbid_idx on perf_artists(mbid)`,
  `create index if not exists perf_artists_name_nocase_idx
    on perf_artists(name collate nocase)`,
  `create table if not exists perf_labels (
    id text primary key,
    name text not null,
    seed_state text not null,
    renderable_track_count integer not null
  )`,
  `create table if not exists perf_albums (
    id text primary key,
    name text not null,
    slug text not null,
    label_id text,
    image_key text,
    image_state text,
    image_updated_at text,
    renderable_track_count integer not null
  )`,
  `create table if not exists perf_tracks (
    id text primary key,
    title text not null,
    artists_json text not null,
    album text,
    album_image_url text,
    label text,
    spotify_url text,
    label_id text,
    album_id text,
    label_scope text not null,
    is_catalogue integer not null,
    youtube_backlog integer not null,
    musicbrainz_isrc_backlog integer not null,
    full_analysis_backlog integer not null,
    release_date text,
    key text,
    created_at text not null,
    anchor_review_json text,
    analyzed_from text,
    artist_credits_backfilled_at text,
    artist_edges_backfilled_at text,
    bpm real,
    capture_priority integer,
    capture_verification text,
    capture_verified_at text,
    deezer_track_id text,
    demand_score integer,
    dismissed_at text,
    duplicate_of_track_id text,
    duration_ms integer not null,
    has_embedding integer not null,
    has_isrc integer not null,
    in_release_id integer,
    isrc text,
    mb_recording_id text,
    mb_recording_id_attempted_at text,
    nearest_finding_score real,
    source_audio_attempted_at text,
    source_audio_key text,
    spotify_anchor_attempted_at text,
    spotify_anchor_attempts integer,
    spotify_uri text
  )`,
  `create index if not exists perf_tracks_album_id_idx on perf_tracks(album_id)`,
  `create index if not exists perf_tracks_label_id_idx on perf_tracks(label_id)`,
  `create index if not exists perf_tracks_is_catalogue_idx
    on perf_tracks(is_catalogue) where is_catalogue = 1`,
  `create index if not exists perf_tracks_fresh_catalogue_idx
    on perf_tracks(is_catalogue, release_date, id)`,
  `create index if not exists perf_tracks_catalogue_active_track_id_idx
    on perf_tracks(is_catalogue, dismissed_at, id)`,
  `create index if not exists perf_tracks_catalogue_ear_idx
    on perf_tracks(is_catalogue, dismissed_at, nearest_finding_score, id)`,
  `create index if not exists perf_tracks_catalogue_capture_idx
    on perf_tracks(is_catalogue, dismissed_at, capture_priority, id)`,
  `create index if not exists perf_tracks_vendor_worklist_idx
    on perf_tracks(is_catalogue, capture_priority, id)`,
  `create index if not exists perf_tracks_funnel_scan_idx
    on perf_tracks(
      is_catalogue, has_embedding, spotify_uri, source_audio_key, analyzed_from,
      dismissed_at, duplicate_of_track_id, nearest_finding_score, duration_ms,
      spotify_anchor_attempted_at, isrc, spotify_anchor_attempts, artists_json, label_id
    )`,
  `create index if not exists perf_tracks_release_date_idx on perf_tracks(release_date)`,
  `create index if not exists perf_tracks_release_date_track_id_idx
    on perf_tracks(release_date, id)`,
  `create index if not exists perf_tracks_bpm_idx on perf_tracks(bpm)`,
  `create index if not exists perf_tracks_source_audio_attempted_at_idx
    on perf_tracks(source_audio_attempted_at)`,
  `create index if not exists perf_tracks_capture_verification_verified_at_idx
    on perf_tracks(capture_verification, capture_verified_at)`,
  `create index if not exists perf_tracks_isrc_idx on perf_tracks(isrc)`,
  `create index if not exists perf_tracks_anchor_queue_idx
    on perf_tracks(isrc) where spotify_uri is null and isrc is not null`,
  `create index if not exists perf_tracks_mb_recording_id_queue_idx
    on perf_tracks(id) where mb_recording_id is null and mb_recording_id_attempted_at is null`,
  `create index if not exists perf_tracks_mb_recording_id_idx on perf_tracks(mb_recording_id)`,
  `create index if not exists perf_tracks_discogs_release_idx
    on perf_tracks(in_release_id) where in_release_id is not null`,
  `create index if not exists perf_tracks_spotify_uri_idx on perf_tracks(spotify_uri)`,
  `create index if not exists perf_tracks_deezer_track_id_idx on perf_tracks(deezer_track_id)`,
  `create index if not exists perf_tracks_artist_edges_backfill_queue_idx
    on perf_tracks(id) where artist_edges_backfilled_at is null`,
  `create index if not exists perf_tracks_artist_credits_backfill_queue_idx
    on perf_tracks(id)
    where artist_credits_backfilled_at is null and artist_edges_backfilled_at is not null`,
  `create index if not exists perf_tracks_embed_queue_idx
    on perf_tracks(id) where source_audio_key is not null and has_embedding = 0`,
  `create index if not exists perf_tracks_anchor_order_idx
    on perf_tracks(has_isrc, has_embedding, nearest_finding_score, id)
    where spotify_uri is null`,
  `create index if not exists perf_tracks_anchor_review_idx
    on perf_tracks(id) where anchor_review_json is not null`,
  `create index if not exists perf_tracks_dismissed_idx
    on perf_tracks(dismissed_at) where dismissed_at is not null`,
  `create index if not exists perf_tracks_demand_score_idx
    on perf_tracks(demand_score) where demand_score is not null`,
  `create index if not exists perf_tracks_key_idx on perf_tracks(key)`,
  `create index if not exists perf_tracks_capture_priority_track_id_idx
    on perf_tracks(capture_priority, id) where capture_priority is not null`,
  `create table if not exists perf_findings (
    track_id text primary key,
    log_id text not null,
    galaxy_id text,
    added_at text not null,
    updated_at text,
    video_squared_at text
  )`,
  `create unique index if not exists perf_findings_log_id_unique on perf_findings(log_id)`,
  `create table if not exists perf_galaxies (
    id text primary key,
    name text
  )`,
  `create table if not exists perf_track_embeddings (
    track_id text primary key,
    embedding_blob blob not null
  )`,
  `create table if not exists perf_track_artists (
    track_id text not null,
    artist_id text not null,
    position integer not null,
    role text,
    primary key (track_id, artist_id)
  )`,
  `create index if not exists perf_track_artists_track_id_idx on perf_track_artists(track_id)`,
  `create index if not exists perf_track_artists_artist_id_idx on perf_track_artists(artist_id)`,
  `create table if not exists perf_crawl_frontier (
    id text primary key,
    attempted_at text,
    created_at text not null,
    demand_rank integer not null,
    done_at text,
    external_id text not null,
    failures integer not null,
    hop integer not null,
    kind text not null,
    label_slug text,
    parent_id text,
    source text not null,
    state text not null,
    updated_at text not null,
    due_at text
  )`,
  `create index if not exists perf_crawl_frontier_state_id_idx
    on perf_crawl_frontier(state, id)`,
  `create index if not exists perf_tracks_label_scope_id_idx
    on perf_tracks(label_scope, id)`,
  `create table if not exists perf_crawl_due_work (
    claim_expires_at text,
    claim_position integer,
    claim_token text,
    claimed_by text,
    created_at text not null,
    demand_rank integer not null,
    generation text not null,
    hop integer not null,
    label_slug text,
    next_due_at text,
    node_id text primary key,
    node_kind text not null,
    parent_id text,
    source_version text not null,
    state text not null,
    storable_rank integer,
    updated_at text not null
  )`,
  `create index if not exists perf_crawl_due_work_release_ready_idx
    on perf_crawl_due_work(state, storable_rank, hop, demand_rank, created_at, node_id)
    where state = 'ready' and node_kind = 'release'`,
  `create index if not exists perf_crawl_due_work_ready_idx
    on perf_crawl_due_work(state, hop, demand_rank, created_at, node_id)
    where state = 'ready'`,
  `create index if not exists perf_crawl_due_work_scheduled_idx
    on perf_crawl_due_work(state, next_due_at, node_id)
    where state = 'scheduled'`,
  `create index if not exists perf_crawl_due_work_repair_idx
    on perf_crawl_due_work(state, node_id)
    where state = 'repair'`,
  `create index if not exists perf_crawl_due_work_lease_idx
    on perf_crawl_due_work(state, claim_expires_at, node_id)
    where state = 'leased'`,
  `create unique index if not exists perf_crawl_due_work_claim_position_idx
    on perf_crawl_due_work(claimed_by, claim_token, claim_position)
    where state = 'leased'`,
  `create index if not exists perf_crawl_due_work_label_slug_node_id_idx
    on perf_crawl_due_work(label_slug, node_id)`,
  `create index if not exists perf_crawl_due_work_parent_id_node_id_idx
    on perf_crawl_due_work(parent_id, node_id)`,
  `create table if not exists perf_crawl_projection_repairs (
    created_at text not null,
    source_epoch integer not null,
    source_id text not null,
    source_type text not null,
    source_version text not null,
    updated_at text not null,
    primary key (source_type, source_id)
  )`,
  `create index if not exists perf_crawl_projection_repairs_order_idx
    on perf_crawl_projection_repairs(source_epoch, source_type, source_id)`,
  `create table if not exists perf_artist_qualification (
    artist_id text primary key,
    certified_finding_count integer not null,
    enabled_credit_half_units integer not null,
    generation text not null,
    is_qualified integer not null,
    source_version text not null,
    updated_at text not null
  )`,
  `create index if not exists perf_artist_qualification_qualified_idx
    on perf_artist_qualification(is_qualified, artist_id)
    where is_qualified = 1`,
  `create table if not exists perf_artist_qualification_contributions (
    artist_id text not null,
    certified_contribution integer not null,
    enabled_credit_half_units integer not null,
    generation text not null,
    source_version text not null,
    track_id text not null,
    updated_at text not null,
    primary key (track_id, artist_id)
  )`,
  `create index if not exists perf_artist_qualification_contributions_artist_track_idx
    on perf_artist_qualification_contributions(artist_id, track_id)`,
  `create table if not exists perf_artist_qualification_state (
    audited_at text,
    completed_at text,
    cursor text,
    generation text not null,
    projected_digest text,
    projected_qualified_count integer not null,
    projection_epoch integer not null,
    rebuild_start_epoch integer not null,
    scanned_count integer not null,
    scope text primary key,
    source_digest text,
    source_epoch integer not null,
    source_qualified_count integer not null,
    started_at text not null,
    state text not null,
    updated_at text not null
  )`,
  `create table if not exists perf_public_aggregate_counts (
    aggregate_kind text not null,
    bucket text not null,
    generation text not null,
    source_version text not null,
    track_count integer not null,
    updated_at text not null,
    primary key (aggregate_kind, bucket)
  )`,
  `create table if not exists perf_public_aggregate_membership (
    generation text not null,
    key_bucket text,
    release_date_bucket text,
    source_version text not null,
    track_id text primary key,
    updated_at text not null
  )`,
  `create table if not exists perf_public_aggregate_state (
    aggregate_epoch integer not null,
    audited_at text,
    completed_at text,
    cursor text,
    default_track_total integer not null,
    generation text not null,
    projected_digest text,
    projected_entry_count integer not null,
    rebuild_start_epoch integer not null,
    release_hub_order_epoch integer not null,
    scanned_count integer not null,
    scope text primary key,
    source_digest text,
    source_entry_count integer not null,
    source_epoch integer not null,
    started_at text not null,
    state text not null,
    updated_at text not null
  )`,
  `create table if not exists perf_projection_repairs (
    created_at text not null,
    projection text not null,
    source_epoch integer not null,
    source_version text not null,
    subject_id text not null,
    subject_type text not null,
    updated_at text not null,
    primary key (projection, subject_type, subject_id)
  )`,
  `create index if not exists perf_projection_repairs_order_idx
    on perf_projection_repairs(projection, source_epoch, subject_type, subject_id)`,
  `create table if not exists perf_hub_page_anchors (
    anchors_json text not null,
    clause_hash text not null,
    computed_at text not null,
    fingerprint text not null,
    hub text not null,
    primary key (hub, clause_hash)
  )`,
  `create table if not exists perf_hub_page_anchor_validity (
    anchor_format_version integer not null,
    clause_hash text not null,
    generation text not null,
    hub text not null,
    order_epoch integer not null,
    published_at text not null,
    primary key (hub, clause_hash)
  )`,
  `create table if not exists due_work (
    claim_expires_at text,
    claim_token text,
    claimed_by text,
    generation text not null,
    next_due_at text not null,
    source_version text not null,
    subject_type text not null,
    work_kind text not null,
    state text not null,
    sort_key text not null,
    subject_id text not null,
    updated_at text not null,
    primary key (work_kind, subject_type, subject_id)
  )`,
  `create index if not exists due_work_ready_idx
    on due_work(work_kind, state, sort_key, subject_id)
    where state = 'ready'`,
  `create index if not exists due_work_scheduled_idx
    on due_work(work_kind, state, next_due_at, subject_id)
    where state = 'scheduled'`,
  `create index if not exists due_work_lease_idx
    on due_work(state, claim_expires_at, work_kind, subject_id)
    where state = 'leased'`,
  `create index if not exists due_work_claim_idx
    on due_work(work_kind, state, claimed_by, claim_token, sort_key, subject_id)
    where state = 'leased'`,
  `create table if not exists perf_due_work (
    claim_expires_at text,
    claim_token text,
    claimed_by text,
    generation text not null,
    next_due_at text not null,
    sort_key text not null,
    source_version text not null,
    state text not null,
    subject_id text not null,
    subject_type text not null,
    updated_at text not null,
    work_kind text not null,
    primary key (work_kind, subject_type, subject_id)
  )`,
  `create index if not exists perf_due_work_ready_idx
    on perf_due_work(work_kind, state, sort_key, subject_id)
    where state = 'ready'`,
  `create index if not exists perf_due_work_scheduled_idx
    on perf_due_work(work_kind, state, next_due_at, subject_id)
    where state = 'scheduled'`,
  `create index if not exists perf_due_work_repair_idx
    on perf_due_work(state, subject_type, subject_id)
    where state = 'repair'`,
  `create index if not exists perf_due_work_lease_idx
    on perf_due_work(state, claim_expires_at, work_kind, subject_id)
    where state = 'leased'`,
  `create index if not exists perf_due_work_claim_idx
    on perf_due_work(work_kind, state, claimed_by, claim_token, sort_key, subject_id)
    where state = 'leased'`,
  `create table if not exists perf_artifact_change_checkpoints (
    consumer_id text not null,
    phase text not null,
    state text not null,
    stream text not null,
    stream_version integer not null,
    updated_at text not null,
    primary key (consumer_id, stream, stream_version, phase)
  )`,
  `create table if not exists perf_artifact_change_consumers (
    consumer_id text primary key,
    state text not null,
    applied_through_seq integer,
    snapshot_seq integer,
    updated_at text not null
  )`,
  `create table if not exists perf_artifact_changes (
    seq integer primary key,
    created_at text not null,
    stream text not null,
    stream_version integer not null,
    subject_type text not null,
    subject_id text not null,
    revision integer not null
  )`,
  `create unique index if not exists perf_artifact_changes_revision_idx
    on perf_artifact_changes(stream, stream_version, subject_type, subject_id, revision)`,
  `create index if not exists perf_artifact_changes_stream_seq_idx
    on perf_artifact_changes(stream, stream_version, seq)`,
  `create table if not exists perf_artifact_change_revisions (
    stream text not null,
    stream_version integer not null,
    subject_type text not null,
    subject_id text not null,
    revision integer not null,
    event_seq integer not null,
    primary key (stream, stream_version, subject_type, subject_id, revision)
  )`,
  `create unique index if not exists perf_artifact_change_revisions_event_seq_idx
    on perf_artifact_change_revisions(event_seq)`,
  `create table if not exists perf_operation_receipts (
    operation_key text primary key,
    operation_id text not null,
    created_at text not null,
    state text not null,
    updated_at text not null
  )`,
  `create index if not exists perf_operation_receipts_stale_accepted_idx
    on perf_operation_receipts(state, updated_at, operation_key)
    where state = 'accepted'`,
  `create table if not exists perf_database_admission_contenders (
    contender_id text primary key,
    owner_id text not null,
    run_id text not null,
    lane text not null,
    state text not null,
    enqueued_at_ms integer not null,
    queue_heartbeat_at_ms integer not null,
    lease_expires_at_ms integer,
    acquired_at_ms integer,
    fencing_token integer
  )`,
  `create unique index if not exists perf_database_admission_contenders_owner_run_idx
    on perf_database_admission_contenders(owner_id, run_id)`,
  `create unique index if not exists perf_database_admission_contenders_active_lane_idx
    on perf_database_admission_contenders(lane)
    where state = 'active'`,
  `create index if not exists perf_database_admission_contenders_queue_idx
    on perf_database_admission_contenders(lane, state, enqueued_at_ms, contender_id)
    where state = 'queued'`,
  `create index if not exists perf_database_admission_contenders_queue_heartbeat_idx
    on perf_database_admission_contenders(state, queue_heartbeat_at_ms, contender_id)
    where state = 'queued'`,
  `create index if not exists perf_database_admission_contenders_lease_idx
    on perf_database_admission_contenders(state, lease_expires_at_ms, lane, contender_id)
    where state = 'active'`,
] as const;

const TRACK_INSERT = `insert or ignore into perf_tracks
  (id, title, artists_json, label_id, album_id, label_scope, is_catalogue,
   youtube_backlog, musicbrainz_isrc_backlog, full_analysis_backlog, release_date, key, created_at,
   anchor_review_json, analyzed_from, artist_credits_backfilled_at, artist_edges_backfilled_at,
   bpm, capture_priority, capture_verification, capture_verified_at, deezer_track_id, demand_score,
   dismissed_at, duplicate_of_track_id, duration_ms, has_embedding, has_isrc, in_release_id, isrc,
   mb_recording_id, mb_recording_id_attempted_at, nearest_finding_score,
   source_audio_attempted_at, source_audio_key, spotify_anchor_attempted_at,
   spotify_anchor_attempts, spotify_uri)
  values (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?, ?
  )`;

const EMBEDDING_BLOB = new Uint8Array(4096);
for (let index = 0; index < EMBEDDING_BLOB.length; index += 1) {
  EMBEDDING_BLOB[index] = (index * 29 + 17) % 251;
}

function padded(index: number): string {
  return index.toString().padStart(9, "0");
}

function syntheticTimestamp(index: number, dayOffset = 0): string {
  return new Date(Date.UTC(2026, 0, 1 + dayOffset, 0, 0, index)).toISOString();
}

function syntheticArtist(index: number): { mbid: null | string; name: string } {
  if (index === 0) {
    return { mbid: "synthetic-mbid-identity", name: "Synthetic Identity" };
  }

  if (index === 1) {
    return { mbid: null, name: "Synthetic Collision" };
  }

  if (index === 2) {
    return { mbid: "synthetic-mbid-collision", name: "Synthetic Collision" };
  }

  return {
    mbid: `synthetic-mbid-${padded(index)}`,
    name: `Synthetic Artist ${padded(index)}`,
  };
}

function syntheticTrackCredits(index: number, artistCount: number): string[] {
  if (index === 0) {
    return ["Synthetic Identity"];
  }

  if (index === 1 || index === 2) {
    return ["Synthetic Collision"];
  }

  if (index === 3) {
    return ["Synthetic Collision", "Synthetic Identity", "Synthetic Identity"];
  }

  if (index === 4) {
    return ["Synthetic Alias"];
  }

  // One exact-profile and one compact-profile finding exercise the certified half of the artist
  // link contract while retaining identical synthetic identity semantics at every scale.
  if (index === 511 || index === 1272) {
    return ["Synthetic Identity"];
  }

  return [syntheticArtist(index % artistCount).name];
}

type SyntheticTrackArtistEdge = {
  artistIndex: number;
  isSecondEdge: boolean;
  trackIndex: number;
};

function syntheticTrackArtistEdge(
  edgeIndex: number,
  counts: FixtureCounts,
): SyntheticTrackArtistEdge | null {
  const secondArtistEdges = counts.trackArtists - counts.tracks;
  const isSecondEdge = edgeIndex >= counts.tracks;
  const trackIndex = isSecondEdge ? edgeIndex - counts.tracks : edgeIndex;

  if (isSecondEdge && trackIndex >= secondArtistEdges) {
    return null;
  }

  let artistIndex = isSecondEdge
    ? (trackIndex * 7 + 3) % counts.artists
    : trackIndex % counts.artists;

  if (isSecondEdge && artistIndex === trackIndex % counts.artists) {
    artistIndex = (artistIndex + 1) % counts.artists;
  }

  return { artistIndex, isSecondEdge, trackIndex };
}

function syntheticCrawlNodeKind(index: number): "artist" | "label" | "release" {
  if (index % 3 === 0) {
    return "release";
  }

  return index % 2 === 0 ? "artist" : "label";
}

function syntheticCrawlLabelSlug(index: number, labelCount: number): string {
  return `synthetic-label-${padded(index % labelCount)}`;
}

function syntheticCrawlParentId(index: number): null | string {
  return index === 0 ? null : `synthetic-frontier-${padded(index - 1)}`;
}

function selected(index: number, total: number, selectedCount: number): boolean {
  if (selectedCount <= 0) {
    return false;
  }

  if (selectedCount >= total) {
    return true;
  }

  return (
    Math.floor(((index + 1) * selectedCount) / total) > Math.floor((index * selectedCount) / total)
  );
}

function assertCounts(counts: FixtureCounts): void {
  const boundedByTracks = [
    ["enabled-label tracks", counts.enabledLabelTracks],
    ["findings", counts.findings],
    ["full-analysis backlog", counts.fullAnalysisBacklog],
    ["MusicBrainz-to-ISRC backlog", counts.musicbrainzIsrcBacklog],
    ["track embeddings", counts.trackEmbeddings],
    ["YouTube-provenance backlog", counts.youtubeProvenanceBacklog],
  ] as const;

  for (const [name, count] of boundedByTracks) {
    if (count < 0 || count > counts.tracks) {
      throw new Error(`${name} must be between zero and the track count`);
    }
  }

  if (counts.pendingFrontier < 0 || counts.pendingFrontier > counts.crawlFrontier) {
    throw new Error("pending frontier count must be between zero and the frontier count");
  }

  if (counts.trackArtists < counts.tracks || counts.trackArtists > counts.tracks * 2) {
    throw new Error("the fixture models one or two artists per track");
  }

  if (counts.albums < 1 || counts.artists < 1 || counts.labels < 1 || counts.tracks < 1) {
    throw new Error("fixture entity and track counts must be positive");
  }
}

async function* generatedChunks(
  table: FixtureTable,
  total: number,
  chunkSize: number,
  build: (index: number) => FixtureStatement | null,
): AsyncGenerator<FixtureChunk> {
  let statements: FixtureStatement[] = [];

  for (let index = 0; index < total; index += 1) {
    const statement = build(index);

    if (statement === null) {
      continue;
    }

    statements.push(statement);

    if (statements.length === chunkSize) {
      yield { statements, table };
      statements = [];
    }
  }

  if (statements.length > 0) {
    yield { statements, table };
  }
}

/**
 * Streams a stable, public-safe fixture. No generated value is derived from a production row or
 * identifier, and at most one configured chunk plus one shared embedding blob is resident.
 */
export async function* generateFixture(
  profile: ScaleProfile,
  options: GenerateFixtureOptions = {},
): AsyncGenerator<FixtureChunk> {
  const counts = options.counts ?? getScaleManifest(profile).counts;
  const chunkSize = options.chunkSize ?? DEFAULT_FIXTURE_CHUNK_SIZE;

  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 2_000) {
    throw new Error("fixture chunk size must be an integer from 1 through 2000");
  }

  assertCounts(counts);
  const aggregateBuckets = publicAggregateFixtureBuckets(counts);

  yield* generatedChunks("perf_artists", counts.artists, chunkSize, (index) => {
    const artist = syntheticArtist(index);

    return {
      args: [
        `synthetic-artist-${padded(index)}`,
        artist.name,
        artist.mbid,
        `synthetic-artist-image-${padded(index)}`,
        `synthetic-artist-image-key-${padded(index)}`,
        "resolved",
        syntheticTimestamp(index),
        4,
      ],
      sql: `insert or ignore into perf_artists
              (id, name, mbid, image_url, image_key, image_state, image_updated_at,
               renderable_track_count) values (?, ?, ?, ?, ?, ?, ?, ?)`,
    };
  });

  yield* generatedChunks("perf_labels", counts.labels, chunkSize, (index) => ({
    args: [
      `synthetic-label-${padded(index)}`,
      `Synthetic Label ${padded(index)}`,
      index % 5 === 0 && counts.labels > 1 ? "disabled" : "enabled",
      4,
    ],
    sql: `insert or ignore into perf_labels
            (id, name, seed_state, renderable_track_count) values (?, ?, ?, ?)`,
  }));

  yield* generatedChunks("perf_albums", counts.albums, chunkSize, (index) => ({
    args: [
      `synthetic-album-${padded(index)}`,
      `Synthetic Album ${padded(index)}`,
      `synthetic-album-${padded(index)}`,
      `synthetic-label-${padded(index % counts.labels)}`,
      `synthetic-album-image-key-${padded(index)}`,
      "resolved",
      syntheticTimestamp(index),
      4,
    ],
    sql: `insert or ignore into perf_albums
            (id, name, slug, label_id, image_key, image_state, image_updated_at,
             renderable_track_count) values (?, ?, ?, ?, ?, ?, ?, ?)`,
  }));

  yield* generatedChunks("perf_tracks", counts.tracks, chunkSize, (index) => {
    const isCatalogue = selected(index, counts.tracks, counts.findings) ? 0 : 1;
    const hasEmbedding = selected(index, counts.tracks, counts.trackEmbeddings) ? 1 : 0;
    const hasIsrc = index % 4 === 0 ? 0 : 1;
    const isrc = hasIsrc === 1 ? `synthetic-isrc-${padded(index)}` : null;
    const spotifyUri = index % 5 === 0 ? null : `synthetic-spotify-uri-${padded(index)}`;
    const mbRecordingId = index % 5 === 0 ? `synthetic-recording-${padded(index)}` : null;
    const mbRecordingIdAttemptedAt = index % 7 === 0 ? syntheticTimestamp(index, 1) : null;
    const nearestFindingScore =
      isCatalogue === 1 && index % 5 === 0 ? 0.5 + (index % 500) / 1_000 : null;
    const capturePriority = isCatalogue === 1 && index % 6 !== 0 ? index % 4 : null;

    return {
      args: [
        `synthetic-track-${padded(index)}`,
        `Synthetic Track ${padded(index)}`,
        JSON.stringify(syntheticTrackCredits(index, counts.artists)),
        `synthetic-label-${padded(index % counts.labels)}`,
        `synthetic-album-${padded(index % counts.albums)}`,
        selected(index, counts.tracks, counts.enabledLabelTracks) ? "enabled" : "other",
        isCatalogue,
        selected(index, counts.tracks, counts.youtubeProvenanceBacklog) ? 1 : 0,
        selected(index, counts.tracks, counts.musicbrainzIsrcBacklog) ? 1 : 0,
        selected(index, counts.tracks, counts.fullAnalysisBacklog) ? 1 : 0,
        releaseDateForIndex(index, aggregateBuckets.releaseDate),
        keyForIndex(index, aggregateBuckets.key),
        SYNTHETIC_FIXTURE_EPOCH,
        index % 89 === 0 ? `synthetic-anchor-review-${padded(index)}` : null,
        index % 5 === 0 ? "full" : "preview",
        index % 13 === 0 ? null : syntheticTimestamp(index, 1),
        index % 11 === 0 ? null : syntheticTimestamp(index, 1),
        150 + (index % 80),
        capturePriority,
        index % 97 === 0 ? "mismatch" : index % 2 === 0 ? "preview-match" : null,
        index % 97 === 0 || index % 2 === 0 ? syntheticTimestamp(index, 2) : null,
        index % 3 === 0 ? null : `synthetic-deezer-${padded(index)}`,
        index % 127 === 0 ? index % 17 : null,
        index % 101 === 0 ? syntheticTimestamp(index, 3) : null,
        index % 211 === 0 ? `synthetic-track-${padded(index)}` : null,
        180_000 + index,
        hasEmbedding,
        hasIsrc,
        index % 37 === 0 ? index + 1 : null,
        isrc,
        mbRecordingId,
        mbRecordingIdAttemptedAt,
        nearestFindingScore,
        index % 4 === 0 ? syntheticTimestamp(index, 1) : null,
        index % 3 === 0 ? `synthetic-audio-${padded(index)}` : null,
        index % 9 === 0 ? syntheticTimestamp(index, 1) : null,
        index % 9 === 0 ? (index % 4) + 1 : 0,
        spotifyUri,
      ],
      sql: TRACK_INSERT,
    };
  });

  const indexCounts = indexFixtureCardinalities(counts);

  yield* generatedChunks("perf_due_work", indexCounts.perf_due_work, chunkSize, (index) => {
    const state = (
      index % 4 === 0
        ? "scheduled"
        : index % 4 === 1
          ? "repair"
          : index % 4 === 2
            ? "leased"
            : "ready"
    ) as "leased" | "ready" | "repair" | "scheduled";
    const subjectId = `synthetic-due-subject-${padded(index)}`;
    const workKind = index % 2 === 0 ? "youtube-provenance-findings" : "mbid-isrc-lookup";
    const isLeased = state === "leased";

    return {
      args: [
        isLeased ? index + 10_000 : null,
        isLeased ? `synthetic-claim-${padded(index)}` : null,
        isLeased ? `synthetic-owner-${padded(index)}` : null,
        "synthetic-index-evidence",
        syntheticTimestamp(index),
        padded(index),
        JSON.stringify([subjectId, workKind]),
        state,
        subjectId,
        "track",
        syntheticTimestamp(index, 1),
        workKind,
      ],
      sql: `insert or ignore into perf_due_work
        (claim_expires_at, claim_token, claimed_by, generation, next_due_at, sort_key,
         source_version, state, subject_id, subject_type, updated_at, work_kind)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    };
  });

  yield* generatedChunks(
    "perf_artifact_change_checkpoints",
    indexCounts.perf_artifact_change_checkpoints,
    chunkSize,
    (index) => ({
      args: [
        `synthetic-consumer-${padded(index)}`,
        "rebuild",
        index % 4 === 0 ? "running" : "complete",
        `synthetic-stream-${index % 3}`,
        1,
        syntheticTimestamp(index, index % 4 === 0 ? 0 : 1),
      ],
      sql: `insert or ignore into perf_artifact_change_checkpoints
        (consumer_id, phase, state, stream, stream_version, updated_at) values (?, ?, ?, ?, ?, ?)`,
    }),
  );

  yield* generatedChunks(
    "perf_artifact_change_consumers",
    indexCounts.perf_artifact_change_consumers,
    chunkSize,
    (index) => ({
      args: [
        `synthetic-consumer-${padded(index)}`,
        index % 3 === 0 ? "active" : index % 3 === 1 ? "rebuilding" : "inactive",
        index % 3 === 0 ? index : null,
        index % 3 === 1 ? index : null,
        syntheticTimestamp(index, 1),
      ],
      sql: `insert or ignore into perf_artifact_change_consumers
        (consumer_id, state, applied_through_seq, snapshot_seq, updated_at) values (?, ?, ?, ?, ?)`,
    }),
  );

  yield* generatedChunks(
    "perf_artifact_changes",
    indexCounts.perf_artifact_changes,
    chunkSize,
    (index) => ({
      args: [
        index + 1,
        syntheticTimestamp(index),
        `synthetic-stream-${index % 3}`,
        1,
        "track",
        `synthetic-track-${padded(index)}`,
        1,
      ],
      sql: `insert or ignore into perf_artifact_changes
        (seq, created_at, stream, stream_version, subject_type, subject_id, revision)
        values (?, ?, ?, ?, ?, ?, ?)`,
    }),
  );

  yield* generatedChunks(
    "perf_artifact_change_revisions",
    indexCounts.perf_artifact_change_revisions,
    chunkSize,
    (index) => ({
      args: [
        `synthetic-stream-${index % 3}`,
        1,
        "track",
        `synthetic-track-${padded(index)}`,
        1,
        index + 1,
      ],
      sql: `insert or ignore into perf_artifact_change_revisions
        (stream, stream_version, subject_type, subject_id, revision, event_seq)
        values (?, ?, ?, ?, ?, ?)`,
    }),
  );

  yield* generatedChunks(
    "perf_operation_receipts",
    indexCounts.perf_operation_receipts,
    chunkSize,
    (index) => ({
      args: [
        `synthetic-operation-key-${padded(index)}`,
        index % 2 === 0 ? "synthetic-operation-a" : "synthetic-operation-b",
        syntheticTimestamp(index),
        index % 3 === 0 ? "accepted" : index % 3 === 1 ? "committed" : "rejected",
        syntheticTimestamp(index, 1),
      ],
      sql: `insert or ignore into perf_operation_receipts
        (operation_key, operation_id, created_at, state, updated_at) values (?, ?, ?, ?, ?)`,
    }),
  );

  yield* generatedChunks(
    "perf_database_admission_contenders",
    indexCounts.perf_database_admission_contenders,
    chunkSize,
    (index) => {
      const isActive = index === 0 || index === 1;
      const lane = index % 2 === 0 ? "write" : "heavy-read";
      const state = isActive ? "active" : "queued";

      return {
        args: [
          `synthetic-contender-${padded(index)}`,
          `synthetic-owner-${padded(index)}`,
          `synthetic-run-${padded(index)}`,
          lane,
          state,
          index * 1_000,
          index * 1_000 + 10,
          isActive ? index * 1_000 + 100 : null,
          isActive ? index * 1_000 + 20 : null,
          isActive ? index + 1 : null,
        ],
        sql: `insert or ignore into perf_database_admission_contenders
          (contender_id, owner_id, run_id, lane, state, enqueued_at_ms,
           queue_heartbeat_at_ms, lease_expires_at_ms, acquired_at_ms, fencing_token)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      };
    },
  );

  yield* generatedChunks("perf_findings", counts.tracks, chunkSize, (index) =>
    selected(index, counts.tracks, counts.findings)
      ? {
          args: [
            `synthetic-track-${padded(index)}`,
            `synthetic-log-${padded(Math.floor((index * counts.findings) / counts.tracks))}`,
            syntheticTimestamp(index),
            index % 5 === 0 ? syntheticTimestamp(index, 31) : null,
            index % 7 === 0 ? syntheticTimestamp(index, 62) : null,
          ],
          sql: `insert or ignore into perf_findings
                  (track_id, log_id, added_at, updated_at, video_squared_at)
                values (?, ?, ?, ?, ?)`,
        }
      : null,
  );

  yield* generatedChunks("perf_track_embeddings", counts.tracks, chunkSize, (index) =>
    selected(index, counts.tracks, counts.trackEmbeddings)
      ? {
          args: [`synthetic-track-${padded(index)}`, EMBEDDING_BLOB],
          sql: "insert or ignore into perf_track_embeddings (track_id, embedding_blob) values (?, ?)",
        }
      : null,
  );

  yield* generatedChunks("perf_track_artists", counts.trackArtists, chunkSize, (edgeIndex) => {
    const edge = syntheticTrackArtistEdge(edgeIndex, counts);

    if (edge === null) {
      return null;
    }

    return {
      args: [
        `synthetic-track-${padded(edge.trackIndex)}`,
        `synthetic-artist-${padded(edge.artistIndex)}`,
        edge.isSecondEdge ? 2 : 1,
        edge.isSecondEdge ? "remixer" : null,
      ],
      sql: "insert or ignore into perf_track_artists (track_id, artist_id, position, role) values (?, ?, ?, ?)",
    };
  });

  yield* generatedChunks("perf_crawl_frontier", counts.crawlFrontier, chunkSize, (index) => {
    const isPending = index < counts.pendingFrontier;
    const nodeKind = syntheticCrawlNodeKind(index);
    const now = syntheticTimestamp(index);

    return {
      args: [
        `synthetic-frontier-${padded(index)}`,
        isPending ? null : syntheticTimestamp(index, 1),
        now,
        index % 2,
        isPending ? null : syntheticTimestamp(index, 2),
        `synthetic-external-${padded(index)}`,
        0,
        index % 3,
        nodeKind,
        nodeKind === "label" ? syntheticCrawlLabelSlug(index, counts.labels) : null,
        syntheticCrawlParentId(index),
        "synthetic-crawl",
        isPending ? "pending" : "done",
        now,
        isPending ? SYNTHETIC_FIXTURE_EPOCH : null,
      ],
      sql: `insert or ignore into perf_crawl_frontier
        (id, attempted_at, created_at, demand_rank, done_at, external_id, failures, hop, kind,
         label_slug, parent_id, source, state, updated_at, due_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    };
  });

  yield* generatedChunks(
    "perf_crawl_due_work",
    counts.pendingFrontier + crawlDueWorkLifecycleExtra(counts),
    chunkSize,
    (index) => {
      const isReady = index < counts.pendingFrontier;
      const lifecycleIndex = index - counts.pendingFrontier;
      const state = isReady
        ? "ready"
        : lifecycleIndex % 3 === 0
          ? "scheduled"
          : lifecycleIndex % 3 === 1
            ? "repair"
            : "leased";
      const isLeased = state === "leased";
      const nodeKind = syntheticCrawlNodeKind(index);
      const nodeId = isReady
        ? `synthetic-frontier-${padded(index)}`
        : `synthetic-frontier-lifecycle-${padded(lifecycleIndex)}`;
      const createdAt = syntheticTimestamp(index);

      return {
        args: [
          isLeased ? syntheticTimestamp(index, 1) : null,
          isLeased ? lifecycleIndex : null,
          isLeased ? `synthetic-crawl-claim-${padded(lifecycleIndex)}` : null,
          isLeased ? "synthetic-crawl-worker" : null,
          createdAt,
          index % 2,
          "synthetic-contract-d",
          index % 3,
          nodeKind === "label" ? syntheticCrawlLabelSlug(index, counts.labels) : null,
          state === "scheduled" ? syntheticTimestamp(index) : null,
          nodeId,
          nodeKind,
          syntheticCrawlParentId(index),
          JSON.stringify([nodeId, state, nodeKind]),
          state,
          state === "ready" && nodeKind === "release" ? index % 2 : null,
          syntheticTimestamp(index, 2),
        ],
        sql: `insert or ignore into perf_crawl_due_work
          (claim_expires_at, claim_position, claim_token, claimed_by, created_at, demand_rank,
           generation, hop, label_slug, next_due_at, node_id, node_kind, parent_id, source_version,
           state, storable_rank, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      };
    },
  );

  const qualifiedArtistCount = Math.min(CONTRACT_D_QUALIFIED_ARTIST_LIMIT, counts.artists);
  yield* generatedChunks("perf_artist_qualification", counts.artists, chunkSize, (index) => {
    const isQualified = index < qualifiedArtistCount;

    return {
      args: [
        `synthetic-artist-${padded(index)}`,
        isQualified ? 1 : 0,
        isQualified ? 6 : 0,
        "synthetic-contract-d",
        isQualified ? 1 : 0,
        "synthetic-public-v1",
        syntheticTimestamp(index, 3),
      ],
      sql: `insert or ignore into perf_artist_qualification
        (artist_id, certified_finding_count, enabled_credit_half_units, generation, is_qualified,
         source_version, updated_at)
        values (?, ?, ?, ?, ?, ?, ?)`,
    };
  });

  yield* generatedChunks(
    "perf_artist_qualification_contributions",
    counts.trackArtists,
    chunkSize,
    (edgeIndex) => {
      const edge = syntheticTrackArtistEdge(edgeIndex, counts);

      if (edge === null) {
        return null;
      }

      const labelIndex = edge.trackIndex % counts.labels;
      const labelEnabled = !(labelIndex % 5 === 0 && counts.labels > 1);
      const trackId = `synthetic-track-${padded(edge.trackIndex)}`;
      const artistId = `synthetic-artist-${padded(edge.artistIndex)}`;

      return {
        args: [
          artistId,
          selected(edge.trackIndex, counts.tracks, counts.findings) ? 1 : 0,
          labelEnabled ? (edge.isSecondEdge ? 1 : 2) : 0,
          "synthetic-contract-d",
          JSON.stringify([trackId, artistId, edge.isSecondEdge ? "remixer" : "primary"]),
          trackId,
          syntheticTimestamp(edge.trackIndex, 3),
        ],
        sql: `insert or ignore into perf_artist_qualification_contributions
          (artist_id, certified_contribution, enabled_credit_half_units, generation, source_version,
           track_id, updated_at)
          values (?, ?, ?, ?, ?, ?, ?)`,
      };
    },
  );

  yield {
    statements: [
      {
        args: [
          syntheticTimestamp(0, 4),
          syntheticTimestamp(0, 5),
          null,
          "synthetic-contract-d",
          "synthetic-artist-source-digest",
          qualifiedArtistCount,
          1,
          1,
          counts.artists,
          "artists",
          "synthetic-artist-source-digest",
          1,
          qualifiedArtistCount,
          SYNTHETIC_FIXTURE_EPOCH,
          "complete",
          syntheticTimestamp(0, 5),
        ],
        sql: `insert or ignore into perf_artist_qualification_state
          (audited_at, completed_at, cursor, generation, projected_digest,
           projected_qualified_count, projection_epoch, rebuild_start_epoch, scanned_count, scope,
           source_digest, source_epoch, source_qualified_count, started_at, state, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      },
    ],
    table: "perf_artist_qualification_state",
  };

  yield* generatedChunks("perf_public_aggregate_membership", counts.tracks, chunkSize, (index) => {
    const releaseDate = releaseDateForIndex(index, aggregateBuckets.releaseDate);
    const key = keyForIndex(index, aggregateBuckets.key);

    return {
      args: [
        "synthetic-contract-d",
        key,
        releaseDate === null ? null : releaseDate.slice(0, 4),
        sourceVersionForPublicTrack(releaseDate, key),
        `synthetic-track-${padded(index)}`,
        syntheticTimestamp(index, 4),
      ],
      sql: `insert or ignore into perf_public_aggregate_membership
        (generation, key_bucket, release_date_bucket, source_version, track_id, updated_at)
        values (?, ?, ?, ?, ?, ?)`,
    };
  });

  const aggregateRows = [
    ...aggregateBuckets.releaseDate
      .filter((entry) => entry.bucket !== null)
      .map((entry) => ({ aggregateKind: "release_date_bucket", ...entry })),
    ...aggregateBuckets.key
      .filter((entry) => entry.bucket !== null)
      .map((entry) => ({ aggregateKind: "key", ...entry })),
  ];
  yield* generatedChunks(
    "perf_public_aggregate_counts",
    aggregateRows.length,
    chunkSize,
    (index) => {
      const entry = aggregateRows[index];

      if (!entry) {
        return null;
      }

      return {
        args: [
          entry.aggregateKind,
          entry.bucket,
          "synthetic-contract-d",
          JSON.stringify([entry.aggregateKind, entry.bucket]),
          entry.count,
          syntheticTimestamp(index, 4),
        ],
        sql: `insert or ignore into perf_public_aggregate_counts
        (aggregate_kind, bucket, generation, source_version, track_count, updated_at)
        values (?, ?, ?, ?, ?, ?)`,
      };
    },
  );

  yield {
    statements: [
      {
        args: [
          1,
          syntheticTimestamp(0, 4),
          syntheticTimestamp(0, 5),
          null,
          counts.tracks,
          "synthetic-contract-d",
          "synthetic-public-source-digest",
          counts.tracks + aggregateRows.length,
          1,
          1,
          counts.tracks,
          "tracks",
          "synthetic-public-source-digest",
          counts.tracks,
          1,
          SYNTHETIC_FIXTURE_EPOCH,
          "complete",
          syntheticTimestamp(0, 5),
        ],
        sql: `insert or ignore into perf_public_aggregate_state
          (aggregate_epoch, audited_at, completed_at, cursor, default_track_total, generation,
           projected_digest, projected_entry_count, rebuild_start_epoch, release_hub_order_epoch,
           scanned_count, scope, source_digest, source_entry_count, source_epoch, started_at, state,
           updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      },
    ],
    table: "perf_public_aggregate_state",
  };

  yield* generatedChunks("perf_projection_repairs", 1, chunkSize, () => ({
    args: [
      syntheticTimestamp(0, 4),
      "synthetic-index-evidence",
      1,
      "synthetic-index-evidence-v1",
      "synthetic-track-000000000",
      "track",
      syntheticTimestamp(0, 4),
    ],
    sql: `insert or ignore into perf_projection_repairs
      (created_at, projection, source_epoch, source_version, subject_id, subject_type, updated_at)
      values (?, ?, ?, ?, ?, ?, ?)`,
  }));

  const anchorRows = defaultAnchorFixtureRows(counts);
  yield {
    statements: [
      {
        args: [
          JSON.stringify(anchorRows),
          "synthetic-default",
          syntheticTimestamp(0, 5),
          defaultAnchorFixtureFingerprint(counts),
          "tracks",
        ],
        sql: `insert or ignore into perf_hub_page_anchors
          (anchors_json, clause_hash, computed_at, fingerprint, hub)
          values (?, ?, ?, ?, ?)`,
      },
    ],
    table: "perf_hub_page_anchors",
  };

  yield {
    statements: [
      {
        args: [
          CONTRACT_D_ANCHOR_FORMAT_VERSION,
          "synthetic-default",
          "synthetic-contract-d",
          "tracks",
          1,
          syntheticTimestamp(0, 5),
        ],
        sql: `insert or ignore into perf_hub_page_anchor_validity
          (anchor_format_version, clause_hash, generation, hub, order_epoch, published_at)
          values (?, ?, ?, ?, ?, ?)`,
      },
    ],
    table: "perf_hub_page_anchor_validity",
  };

  const dueWorkQueues = [
    { count: counts.youtubeProvenanceBacklog, workKind: "youtube-provenance-findings" },
    { count: counts.musicbrainzIsrcBacklog, workKind: "mbid-isrc-lookup" },
  ] as const;
  for (const queue of dueWorkQueues) {
    yield* generatedChunks("due_work", queue.count, chunkSize, (index) => ({
      args: [
        "fixture",
        SYNTHETIC_FIXTURE_EPOCH,
        `fixture-${queue.workKind}-${padded(index)}`,
        "ready",
        padded(index),
        `synthetic-${queue.workKind}-${padded(index)}`,
        "track",
        SYNTHETIC_FIXTURE_EPOCH,
        queue.workKind,
      ],
      sql: `insert or ignore into due_work
        (generation, next_due_at, source_version, state, sort_key, subject_id,
         subject_type, updated_at, work_kind)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    }));
  }
}

export async function applyFixtureSchema(sink: FixtureBatchSink): Promise<void> {
  await sink.batch(
    PERFORMANCE_FIXTURE_SCHEMA.map((sql) => ({ args: [], sql })),
    "write",
  );
}

/** Drops only the harness-owned allowlist so an exact profile cannot inherit rows from a prior run. */
export async function resetFixture(sink: FixtureBatchSink): Promise<void> {
  await sink.batch(
    [FIXTURE_IDENTITY_TABLE, ...FIXTURE_TABLES]
      .reverse()
      .map((table) => ({ args: [], sql: `drop table if exists ${table}` })),
    "write",
  );
}

export async function writeFixture(
  sink: FixtureBatchSink,
  profile: ScaleProfile,
  options: GenerateFixtureOptions = {},
): Promise<Record<FixtureTable, number>> {
  const written = Object.fromEntries(FIXTURE_TABLES.map((table) => [table, 0])) as Record<
    FixtureTable,
    number
  >;

  for await (const chunk of generateFixture(profile, options)) {
    await sink.batch(chunk.statements, "write");
    written[chunk.table] += chunk.statements.length;
  }

  return written;
}

const FIXTURE_DISTRIBUTION_QUERIES = {
  albums: "select count(*) as count from perf_albums",
  artists: "select count(*) as count from perf_artists",
  crawlFrontier: "select count(*) as count from perf_crawl_frontier",
  enabledLabelTracks: "select count(*) as count from perf_tracks where label_scope = 'enabled'",
  findings: "select count(*) as count from perf_findings",
  fullAnalysisBacklog: "select count(*) as count from perf_tracks where full_analysis_backlog = 1",
  labels: "select count(*) as count from perf_labels",
  musicbrainzIsrcBacklog:
    "select count(*) as count from perf_tracks where musicbrainz_isrc_backlog = 1",
  pendingFrontier: "select count(*) as count from perf_crawl_frontier where state = 'pending'",
  trackArtists: "select count(*) as count from perf_track_artists",
  trackEmbeddings: "select count(*) as count from perf_track_embeddings",
  tracks: "select count(*) as count from perf_tracks",
  youtubeProvenanceBacklog: "select count(*) as count from perf_tracks where youtube_backlog = 1",
} as const satisfies Record<keyof FixtureCounts, string>;

function censusCount(result: Pick<ResultSet, "rows">, label: string): number {
  const value = result.rows[0]?.count;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`fixture census ${label} did not return one non-negative safe integer`);
  }
  return count;
}

type BoundedCensusTarget =
  | { kind: "distribution"; name: keyof FixtureCounts }
  | { kind: "table"; table: FixtureTable };

type BoundedCensusQuery =
  | {
      expectedCount: number | null;
      kind: "range";
      label: string;
      statement: FixtureStatement;
      target: BoundedCensusTarget;
    }
  | {
      kind: "sentinel";
      label: string;
      statement: FixtureStatement;
      table: FixtureTable;
    };

const BOUNDED_DISTRIBUTION_SOURCES = {
  enabledLabelTracks: {
    predicate: "label_scope = 'enabled'",
    table: "perf_tracks",
  },
  fullAnalysisBacklog: {
    predicate: "full_analysis_backlog = 1",
    table: "perf_tracks",
  },
  musicbrainzIsrcBacklog: {
    predicate: "musicbrainz_isrc_backlog = 1",
    table: "perf_tracks",
  },
  pendingFrontier: {
    predicate: "state = 'pending'",
    table: "perf_crawl_frontier",
  },
  youtubeProvenanceBacklog: {
    predicate: "youtube_backlog = 1",
    table: "perf_tracks",
  },
} as const satisfies Partial<
  Record<keyof FixtureCounts, { predicate: string; table: FixtureTable }>
>;

const TABLE_DISTRIBUTIONS = {
  albums: "perf_albums",
  artists: "perf_artists",
  crawlFrontier: "perf_crawl_frontier",
  findings: "perf_findings",
  labels: "perf_labels",
  trackArtists: "perf_track_artists",
  trackEmbeddings: "perf_track_embeddings",
  tracks: "perf_tracks",
} as const satisfies Partial<Record<keyof FixtureCounts, FixtureTable>>;

type FixtureDistributionPartition = {
  filtered: readonly string[];
  table: readonly string[];
};

export function assertBoundedFixtureDistributionCoverage(
  expectedDistributions: FixtureCounts,
  partition: FixtureDistributionPartition = {
    filtered: Object.keys(BOUNDED_DISTRIBUTION_SOURCES),
    table: Object.keys(TABLE_DISTRIBUTIONS),
  },
): void {
  const expected = Object.keys(expectedDistributions).sort();
  const combined = [...partition.filtered, ...partition.table];
  const duplicates = [
    ...new Set(combined.filter((name, index) => combined.indexOf(name) !== index)),
  ].sort();
  const actual = [...new Set(combined)].sort();
  const missing = expected.filter((name) => !actual.includes(name));
  const unexpected = actual.filter((name) => !expected.includes(name));

  if (duplicates.length > 0 || missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `fixture census distribution partition invalid: missing [${missing.join(", ")}]; duplicated [${duplicates.join(", ")}]; unexpected [${unexpected.join(", ")}]`,
    );
  }
}

/**
 * Fresh fixture construction creates every allowlisted rowid table once and inserts its stable rows
 * in order, guaranteeing dense rowids 1..N. The census proves that construction invariant; the
 * separate boundary sentinel prevents a deletion and an out-of-range insert from compensating.
 */
function boundedCensusQueriesForSource(options: {
  expectedRows: number;
  maxRowsPerStatement: number;
  predicate?: string;
  rangeRows?: number;
  target: BoundedCensusTarget;
  table: FixtureTable;
}): BoundedCensusQuery[] {
  const predicate = options.predicate === undefined ? "" : ` and ${options.predicate}`;
  const label =
    options.target.kind === "table"
      ? `table ${options.target.table}`
      : `distribution ${options.target.name}`;
  const queries: BoundedCensusQuery[] = [];

  if (options.target.kind === "table") {
    queries.push({
      kind: "sentinel",
      label: `${label} rowid boundary`,
      statement: {
        args: [options.expectedRows],
        sql: `select
          exists(select 1 from ${options.table} not indexed where rowid < 1 limit 1) as underflow,
          exists(select 1 from ${options.table} not indexed where rowid > ? limit 1) as overflow`,
      },
      table: options.table,
    });
  }

  const rangeRows = options.rangeRows ?? options.expectedRows;
  for (let start = 1; start <= rangeRows; start += options.maxRowsPerStatement) {
    const end = Math.min(rangeRows, start + options.maxRowsPerStatement - 1);
    const embeddingIndexRange =
      options.table === "perf_track_embeddings" && options.target.kind === "table";
    queries.push({
      expectedCount:
        options.target.kind === "table" && !embeddingIndexRange ? end - start + 1 : null,
      kind: "range",
      label: `${label} ${embeddingIndexRange ? "track_id" : "rowid"} ${start}-${end}`,
      statement: embeddingIndexRange
        ? {
            args: [`synthetic-track-${padded(start - 1)}`, `synthetic-track-${padded(end - 1)}`],
            sql: `select count(*) as count from perf_track_embeddings where track_id between ? and ?`,
          }
        : {
            args: [start, end],
            sql: `select count(*) as count from ${options.table} not indexed where rowid between ? and ?${predicate}`,
          },
      target: options.target,
    });
  }

  return queries;
}

function buildBoundedCensusQueries(
  expectedDistributions: FixtureCounts,
  expectedTables: FixtureTableCardinalities,
  maxRowsPerStatement: number,
): BoundedCensusQuery[] {
  const queries = FIXTURE_TABLES.flatMap((table) =>
    boundedCensusQueriesForSource({
      expectedRows: expectedTables[table],
      maxRowsPerStatement,
      // Embeddings are deterministically selected across the full track-key domain rather than
      // packed into its first N keys, so the covering-index windows must span every synthetic track.
      rangeRows: table === "perf_track_embeddings" ? expectedDistributions.tracks : undefined,
      table,
      target: { kind: "table", table },
    }),
  );

  for (const [name, source] of Object.entries(BOUNDED_DISTRIBUTION_SOURCES) as [
    keyof typeof BOUNDED_DISTRIBUTION_SOURCES,
    (typeof BOUNDED_DISTRIBUTION_SOURCES)[keyof typeof BOUNDED_DISTRIBUTION_SOURCES],
  ][]) {
    queries.push(
      ...boundedCensusQueriesForSource({
        expectedRows: expectedTables[source.table],
        maxRowsPerStatement,
        predicate: source.predicate,
        table: source.table,
        target: { kind: "distribution", name },
      }),
    );
  }

  return queries;
}

export function boundedFixtureCensusRequestCount(
  expectedDistributions: FixtureCounts,
  options: { maxRowsPerStatement?: number; statementsPerRequest?: number } = {},
): number {
  const maxRowsPerStatement = options.maxRowsPerStatement ?? HOSTED_FIXTURE_CENSUS_ROW_LIMIT;
  const statementsPerRequest = options.statementsPerRequest ?? 1;
  assertBoundedFixtureDistributionCoverage(expectedDistributions);
  if (
    !Number.isSafeInteger(maxRowsPerStatement) ||
    maxRowsPerStatement < 1 ||
    maxRowsPerStatement > HOSTED_FIXTURE_CENSUS_ROW_LIMIT
  ) {
    throw new Error(
      `fixture census rows per statement must be an integer from 1 through ${HOSTED_FIXTURE_CENSUS_ROW_LIMIT}`,
    );
  }
  if (statementsPerRequest !== 1) {
    throw new Error("bounded fixture census requires exactly one statement per request");
  }
  const queries = buildBoundedCensusQueries(
    expectedDistributions,
    expectedFixtureTableCardinalities(expectedDistributions),
    maxRowsPerStatement,
  );

  return Math.ceil(queries.length / statementsPerRequest);
}

function censusSentinel(
  result: Pick<ResultSet, "rows">,
  field: "overflow" | "underflow",
  label: string,
): number {
  const value = Number(result.rows[0]?.[field]);
  if (value !== 0 && value !== 1) {
    throw new Error(`fixture census ${label} did not return a boolean integer`);
  }
  return value;
}

async function auditBoundedFixtureCardinality(
  client: Client,
  expectedDistributions: FixtureCounts,
  expectedTables: FixtureTableCardinalities,
  options: FixtureCensusOptions & { maxRowsPerStatement: number },
): Promise<FixtureCensus> {
  const statementsPerRequest = options.statementsPerRequest ?? 1;
  assertBoundedFixtureDistributionCoverage(expectedDistributions);
  if (statementsPerRequest !== 1) {
    throw new Error("bounded fixture census requires exactly one statement per request");
  }
  const queries = buildBoundedCensusQueries(
    expectedDistributions,
    expectedTables,
    options.maxRowsPerStatement,
  );
  const requestCount = Math.ceil(queries.length / statementsPerRequest);
  const observedTables = Object.fromEntries(
    FIXTURE_TABLES.map((table) => [table, 0]),
  ) as FixtureTableCardinalities;
  const observedDistributions = Object.fromEntries(
    (Object.keys(expectedDistributions) as (keyof FixtureCounts)[]).map((name) => [name, 0]),
  ) as FixtureCounts;
  const mismatches: string[] = [];

  for (let offset = 0; offset < queries.length; offset += statementsPerRequest) {
    const chunk = queries.slice(offset, offset + statementsPerRequest);
    options.onRequest?.(Math.floor(offset / statementsPerRequest) + 1, requestCount);
    const results = await client.batch(
      chunk.map((query) => query.statement),
      "read",
    );

    for (const [index, query] of chunk.entries()) {
      const result = results[index] ?? { rows: [] };
      if (query.kind === "sentinel") {
        const underflow = censusSentinel(result, "underflow", `${query.label} underflow`);
        const overflow = censusSentinel(result, "overflow", `${query.label} overflow`);
        if (underflow !== 0) {
          mismatches.push(`${query.label} underflow: expected 0, observed ${underflow}`);
        }
        if (overflow !== 0) {
          mismatches.push(`${query.label} overflow: expected 0, observed ${overflow}`);
        }
        continue;
      }

      const count = censusCount(result, query.label);
      if (query.target.kind === "table") {
        observedTables[query.target.table] += count;
      } else {
        observedDistributions[query.target.name] += count;
      }
      if (query.expectedCount !== null && count !== query.expectedCount) {
        mismatches.push(`${query.label}: expected ${query.expectedCount}, observed ${count}`);
      }
    }
  }

  for (const [name, table] of Object.entries(TABLE_DISTRIBUTIONS) as [
    keyof typeof TABLE_DISTRIBUTIONS,
    FixtureTable,
  ][]) {
    observedDistributions[name] = observedTables[table];
  }

  for (const table of FIXTURE_TABLES) {
    if (observedTables[table] !== expectedTables[table]) {
      mismatches.push(
        `table ${table}: expected ${expectedTables[table]}, observed ${observedTables[table]}`,
      );
    }
  }
  for (const name of Object.keys(expectedDistributions) as (keyof FixtureCounts)[]) {
    if (observedDistributions[name] !== expectedDistributions[name]) {
      mismatches.push(
        `distribution ${name}: expected ${expectedDistributions[name]}, observed ${observedDistributions[name]}`,
      );
    }
  }

  return {
    distributions: { expected: expectedDistributions, observed: observedDistributions },
    mismatches,
    passed: mismatches.length === 0,
    tables: { expected: expectedTables, observed: observedTables },
  };
}

/** Reads the committed database state after fixture writes; generator attempt counts are not proof. */
export async function auditFixtureCardinality(
  client: Client,
  expectedDistributions: FixtureCounts,
  options: FixtureCensusOptions = {},
): Promise<FixtureCensus> {
  const expectedTables = expectedFixtureTableCardinalities(expectedDistributions);
  if (options.maxRowsPerStatement !== undefined) {
    if (
      !Number.isSafeInteger(options.maxRowsPerStatement) ||
      options.maxRowsPerStatement < 1 ||
      options.maxRowsPerStatement > HOSTED_FIXTURE_CENSUS_ROW_LIMIT
    ) {
      throw new Error(
        `fixture census rows per statement must be an integer from 1 through ${HOSTED_FIXTURE_CENSUS_ROW_LIMIT}`,
      );
    }
    return auditBoundedFixtureCardinality(client, expectedDistributions, expectedTables, {
      ...options,
      maxRowsPerStatement: options.maxRowsPerStatement,
    });
  }
  const distributionEntries = Object.entries(FIXTURE_DISTRIBUTION_QUERIES) as [
    keyof FixtureCounts,
    string,
  ][];
  const queries = [
    ...FIXTURE_TABLES.map((table) => `select count(*) as count from ${table}`),
    ...distributionEntries.map(([, sql]) => sql),
  ];
  const statementsPerRequest = options.statementsPerRequest ?? FIXTURE_CENSUS_QUERY_CHUNK_SIZE;
  if (!Number.isSafeInteger(statementsPerRequest) || statementsPerRequest < 1) {
    throw new Error("fixture census statements per request must be a positive safe integer");
  }
  const requestCount = Math.ceil(queries.length / statementsPerRequest);
  const results: ResultSet[] = [];
  for (let offset = 0; offset < queries.length; offset += statementsPerRequest) {
    options.onRequest?.(Math.floor(offset / statementsPerRequest) + 1, requestCount);
    results.push(
      ...(await client.batch(queries.slice(offset, offset + statementsPerRequest), "read")),
    );
  }
  const observedTables = Object.fromEntries(
    FIXTURE_TABLES.map((table, index) => [
      table,
      censusCount(results[index] ?? { rows: [] }, `table ${table}`),
    ]),
  ) as FixtureTableCardinalities;
  const observedDistributions = Object.fromEntries(
    distributionEntries.map(([name], index) => [
      name,
      censusCount(results[FIXTURE_TABLES.length + index] ?? { rows: [] }, `distribution ${name}`),
    ]),
  ) as FixtureCounts;
  const mismatches: string[] = [];

  for (const table of FIXTURE_TABLES) {
    if (observedTables[table] !== expectedTables[table]) {
      mismatches.push(
        `table ${table}: expected ${expectedTables[table]}, observed ${observedTables[table]}`,
      );
    }
  }
  for (const name of Object.keys(expectedDistributions) as (keyof FixtureCounts)[]) {
    if (observedDistributions[name] !== expectedDistributions[name]) {
      mismatches.push(
        `distribution ${name}: expected ${expectedDistributions[name]}, observed ${observedDistributions[name]}`,
      );
    }
  }

  return {
    distributions: { expected: expectedDistributions, observed: observedDistributions },
    mismatches,
    passed: mismatches.length === 0,
    tables: { expected: expectedTables, observed: observedTables },
  };
}

/** A streaming fingerprint used to prove repeatability without retaining generated rows. */
export async function fixtureFingerprint(
  profile: ScaleProfile,
  options: GenerateFixtureOptions = {},
): Promise<string> {
  const digest = createHash("sha256");

  for await (const chunk of generateFixture(profile, options)) {
    for (const statement of chunk.statements) {
      digest.update(chunk.table);
      digest.update(statement.sql);
      for (const value of statement.args) {
        if (value instanceof Uint8Array) {
          digest.update(value);
        } else {
          digest.update(JSON.stringify(value));
        }
      }
    }
  }

  return digest.digest("hex");
}
