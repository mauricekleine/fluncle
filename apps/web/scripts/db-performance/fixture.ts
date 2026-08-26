import { createHash } from "node:crypto";

import { getScaleManifest, type FixtureCounts, type ScaleProfile } from "./manifest";

export const DEFAULT_FIXTURE_CHUNK_SIZE = 500;
export const SYNTHETIC_FIXTURE_EPOCH = "2026-01-01T00:00:00.000Z";

export const FIXTURE_TABLES = [
  "perf_artists",
  "perf_labels",
  "perf_albums",
  "perf_tracks",
  "perf_findings",
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
] as const;

export type FixtureTable = (typeof FIXTURE_TABLES)[number];
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
    perf_crawl_due_work: counts.pendingFrontier,
    perf_crawl_projection_repairs: 0,
    perf_hub_page_anchor_validity: 1,
    perf_hub_page_anchors: 1,
    perf_projection_repairs: 0,
    perf_public_aggregate_counts:
      buckets.releaseDate.filter((entry) => entry.bucket !== null).length +
      buckets.key.filter((entry) => entry.bucket !== null).length,
    perf_public_aggregate_membership: counts.tracks,
    perf_public_aggregate_state: 1,
  };
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

function releaseDateForIndex(index: number, buckets: readonly ProjectionBucket[]): null | string {
  return bucketForIndex(index, buckets);
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
          key: bucket.bucket === null ? null : bucket.bucket,
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
    label_id text,
    renderable_track_count integer not null
  )`,
  `create table if not exists perf_tracks (
    id text primary key,
    title text not null,
    artists_json text not null,
    label_id text,
    album_id text,
    label_scope text not null,
    is_catalogue integer not null,
    youtube_backlog integer not null,
    musicbrainz_isrc_backlog integer not null,
    full_analysis_backlog integer not null,
    release_date text,
    key text,
    created_at text not null
  )`,
  `create index if not exists perf_tracks_release_date_track_id_idx
    on perf_tracks(release_date, id)`,
  `create table if not exists perf_findings (
    track_id text primary key,
    log_id text not null,
    added_at text not null,
    updated_at text,
    video_squared_at text
  )`,
  `create unique index if not exists perf_findings_log_id_unique on perf_findings(log_id)`,
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
] as const;

const TRACK_INSERT = `insert or ignore into perf_tracks
  (id, title, artists_json, label_id, album_id, label_scope, is_catalogue,
   youtube_backlog, musicbrainz_isrc_backlog, full_analysis_backlog, release_date, key, created_at)
  values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

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
      args: [`synthetic-artist-${padded(index)}`, artist.name, artist.mbid, 4],
      sql: `insert or ignore into perf_artists
              (id, name, mbid, renderable_track_count) values (?, ?, ?, ?)`,
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
      `synthetic-label-${padded(index % counts.labels)}`,
      4,
    ],
    sql: `insert or ignore into perf_albums
            (id, name, label_id, renderable_track_count) values (?, ?, ?, ?)`,
  }));

  yield* generatedChunks("perf_tracks", counts.tracks, chunkSize, (index) => ({
    args: [
      `synthetic-track-${padded(index)}`,
      `Synthetic Track ${padded(index)}`,
      JSON.stringify(syntheticTrackCredits(index, counts.artists)),
      `synthetic-label-${padded(index % counts.labels)}`,
      `synthetic-album-${padded(index % counts.albums)}`,
      selected(index, counts.tracks, counts.enabledLabelTracks) ? "enabled" : "other",
      selected(index, counts.tracks, counts.findings) ? 0 : 1,
      selected(index, counts.tracks, counts.youtubeProvenanceBacklog) ? 1 : 0,
      selected(index, counts.tracks, counts.musicbrainzIsrcBacklog) ? 1 : 0,
      selected(index, counts.tracks, counts.fullAnalysisBacklog) ? 1 : 0,
      releaseDateForIndex(index, aggregateBuckets.releaseDate),
      keyForIndex(index, aggregateBuckets.key),
      SYNTHETIC_FIXTURE_EPOCH,
    ],
    sql: TRACK_INSERT,
  }));

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

  yield* generatedChunks("perf_crawl_due_work", counts.pendingFrontier, chunkSize, (index) => {
    const nodeKind = syntheticCrawlNodeKind(index);
    const nodeId = `synthetic-frontier-${padded(index)}`;
    const createdAt = syntheticTimestamp(index);

    return {
      args: [
        null,
        null,
        null,
        null,
        createdAt,
        index % 2,
        "synthetic-contract-d",
        index % 3,
        nodeKind === "label" ? syntheticCrawlLabelSlug(index, counts.labels) : null,
        null,
        nodeId,
        nodeKind,
        syntheticCrawlParentId(index),
        JSON.stringify([nodeId, "ready", nodeKind]),
        "ready",
        nodeKind === "release" ? index % 2 : null,
        syntheticTimestamp(index, 2),
      ],
      sql: `insert or ignore into perf_crawl_due_work
        (claim_expires_at, claim_position, claim_token, claimed_by, created_at, demand_rank,
         generation, hop, label_slug, next_due_at, node_id, node_kind, parent_id, source_version,
         state, storable_rank, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    };
  });

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
    [...FIXTURE_TABLES]
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
