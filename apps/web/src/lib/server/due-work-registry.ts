import { type Row } from "@libsql/client";

import { parseArtistsJson } from "./artists";
import {
  CATALOGUE_RANK_STATE_KEY,
  QUALIFIED_ARTISTS_SQL,
  parseCatalogueRankState,
  qualifiedArtistsDigest,
  rankCorpus,
} from "./catalogue";
import { readQualifiedArtistIds } from "./public-projection-cutover";
import {
  DUE_WORK_KINDS,
  dueWorkEntitySourceVersion,
  evaluateAlbumBio,
  evaluateAlbumCoverMaster,
  evaluateArtistBio,
  evaluateArtistCoverMaster,
  evaluateArtistImage,
  evaluateFindingContextNormal,
  evaluateFindingContextRetryEmpty,
  evaluateFindingEnrich,
  evaluateFindingNote,
  evaluateFindingObserve,
  evaluateFindingRenderNormal,
  evaluateFindingRenderRequiresObservation,
  evaluateLabelBio,
  evaluateLabelImage,
  type ArtistImageSource,
  type CoverMasterSource,
  type DueWorkKind as DueWorkEntityKind,
  type DueWorkRow as DueWorkEntityRow,
  type DueWorkSourceByKind,
  type EntityBioSource,
  type FindingRenderSource,
} from "./due-work-entity-definitions";
import {
  DUE_WORK_TRACK_WORK_KIND_INVENTORY,
  dueWorkTrackSourceVersion,
  evaluateDueWorkQueue,
  type DueWorkScope,
  type DueWorkTrackSource,
} from "./due-work-track-definitions";
import {
  DUE_WORK_VENDOR_WORK_KIND_INVENTORY,
  dueWorkVendorSourceVersion,
  evaluateDueWorkVendorQueue,
  type DueWorkVendorKind,
  type DueWorkVendorSource,
} from "./due-work-vendor-definitions";
import {
  type DueWorkClient,
  type DueWorkProjection,
  type DueWorkRebuildDefinition,
  type DueWorkRebuildSource,
  type DueWorkRepairDefinition,
  type DueWorkRow,
  type DueWorkSubjectType,
} from "./due-work";

type TrackSourceRow = Row & {
  analyzed_at: null | string;
  analyzed_from: null | string;
  artists_json: string;
  capture_priority: bigint | null | number;
  capture_status: null | string;
  demand_score: bigint | null | number;
  dismissed_at: null | string;
  duplicate_of_track_id: null | string;
  duration_ms: bigint | null | number;
  finding_added_at: null | string;
  finding_track_id: null | string;
  has_embedding: bigint | number;
  has_isrc: bigint | number;
  isrc: null | string;
  isrc_recovery_attempted_at: null | string;
  label_seed_state: null | string;
  log_id: null | string;
  nearest_finding_score: bigint | null | number;
  source_audio_attempted_at: null | string;
  source_audio_failures: bigint | null | number;
  source_audio_key: null | string;
  source_verification: null | string;
  spotify_anchor_attempted_at: null | string;
  spotify_anchor_attempts: bigint | null | number;
  spotify_uri: null | string;
  title: string;
  track_id: string;
  youtube_provenance_failures: bigint | null | number;
  youtube_verified_at: null | string;
  youtube_video_id: null | string;
  youtube_video_official: bigint | null | number;
};

export type TrackDueWorkSource = DueWorkTrackSource & {
  cursor: string;
  sourceVersion: string;
  subjectId: string;
};

const TRACK_SOURCE_SELECT = `select
  t.analyzed_at, t.analyzed_from, t.artists_json, t.capture_priority, t.capture_status,
  t.demand_score, t.dismissed_at, t.duration_ms, t.duplicate_of_track_id, t.has_embedding,
  t.has_isrc, t.isrc, t.isrc_recovery_attempted_at, t.nearest_finding_score,
  t.source_audio_attempted_at, t.source_audio_failures, t.source_audio_key,
  t.source_verification, t.spotify_anchor_attempted_at, t.spotify_anchor_attempts,
  t.spotify_uri, t.title, t.track_id, t.youtube_provenance_failures,
  t.youtube_verified_at, t.youtube_video_id, t.youtube_video_official,
  f.added_at as finding_added_at, f.log_id, f.track_id as finding_track_id,
  l.seed_state as label_seed_state
from tracks t
left join findings f on f.track_id = t.track_id
left join labels l on l.id = t.label_id`;

function numberOrNull(value: bigint | null | number): null | number {
  return value === null ? null : Number(value);
}

function booleanValue(value: bigint | null | number): boolean {
  return Number(value) === 1;
}

function labelSeedState(value: null | string): DueWorkTrackSource["labelSeedState"] {
  return value === "disabled" || value === "enabled" || value === "undecided" ? value : null;
}

function analyzedFrom(value: null | string): DueWorkTrackSource["analyzedFrom"] {
  return value === "full" || value === "preview" ? value : null;
}

function trackSource(row: TrackSourceRow): TrackDueWorkSource {
  const source: DueWorkTrackSource = {
    analyzedAt: row.analyzed_at,
    analyzedFrom: analyzedFrom(row.analyzed_from),
    artistsJson: row.artists_json,
    capturePriority: numberOrNull(row.capture_priority),
    captureStatus: row.capture_status,
    certified: row.finding_track_id !== null,
    demandScore: numberOrNull(row.demand_score),
    dismissedAt: row.dismissed_at,
    duplicateOfTrackId: row.duplicate_of_track_id,
    durationMs: numberOrNull(row.duration_ms),
    findingAddedAt: row.finding_added_at,
    hasEmbedding: booleanValue(row.has_embedding),
    hasIsrc: booleanValue(row.has_isrc),
    isrc: row.isrc,
    isrcRecoveryAttemptedAt: row.isrc_recovery_attempted_at,
    labelSeedState: labelSeedState(row.label_seed_state),
    logId: row.log_id,
    nearestFindingScore: numberOrNull(row.nearest_finding_score),
    sourceAudioAttemptedAt: row.source_audio_attempted_at,
    sourceAudioFailures: numberOrNull(row.source_audio_failures),
    sourceAudioKey: row.source_audio_key,
    sourceVerification: row.source_verification,
    spotifyAnchorAttemptedAt: row.spotify_anchor_attempted_at,
    spotifyAnchorAttempts: numberOrNull(row.spotify_anchor_attempts),
    spotifyUri: row.spotify_uri,
    title: row.title,
    trackId: row.track_id,
    youtubeProvenanceFailures: numberOrNull(row.youtube_provenance_failures),
    youtubeVerifiedAt: row.youtube_verified_at,
    youtubeVideoId: row.youtube_video_id,
    youtubeVideoOfficial:
      row.youtube_video_official === null ? null : booleanValue(row.youtube_video_official),
  };

  return {
    ...source,
    cursor: source.trackId,
    sourceVersion: dueWorkTrackSourceVersion(source),
    subjectId: source.trackId,
  };
}

export async function readTrackDueWorkSourceChunk(
  client: DueWorkClient,
  options: { after: null | string; limit: number },
): Promise<TrackDueWorkSource[]> {
  const result = await client.execute({
    args: [options.after ?? "", options.limit],
    sql: `${TRACK_SOURCE_SELECT}
      where t.track_id > ?
      order by t.track_id
      limit ?`,
  });
  return (result.rows as TrackSourceRow[]).map(trackSource);
}

export async function readTrackDueWorkSource(
  client: DueWorkClient,
  trackId: string,
): Promise<TrackDueWorkSource | undefined> {
  const result = await client.execute({
    args: [trackId],
    sql: `${TRACK_SOURCE_SELECT} where t.track_id = ? limit 1`,
  });
  const row = result.rows[0] as TrackSourceRow | undefined;
  return row === undefined ? undefined : trackSource(row);
}

async function readTrackDueWorkSources(
  client: DueWorkClient,
  trackIds: readonly string[],
): Promise<Map<string, TrackDueWorkSource>> {
  if (trackIds.length === 0) {
    return new Map();
  }
  const placeholders = trackIds.map(() => "?").join(", ");
  const result = await client.execute({
    args: [...trackIds],
    sql: `${TRACK_SOURCE_SELECT} where t.track_id in (${placeholders})`,
  });
  return new Map(
    (result.rows as TrackSourceRow[]).map(trackSource).map((source) => [source.trackId, source]),
  );
}

type TrackWorkInventoryEntry = (typeof DUE_WORK_TRACK_WORK_KIND_INVENTORY)[number];

function projectTrackSource(
  entry: TrackWorkInventoryEntry,
  source: TrackDueWorkSource,
  context: { generation: string; now: string },
): DueWorkProjection<string> | null {
  const row = evaluateDueWorkQueue({
    kind: entry.kind,
    now: context.now,
    scope: entry.scope as DueWorkScope,
    sources: [source],
  })[0];
  return row === undefined
    ? null
    : projectionFromRow(
        row,
        {
          generation: context.generation,
          subjectId: source.trackId,
          subjectType: "track",
          workKind: entry.workKind,
        },
        context.now,
      );
}

function trackBackfillDefinition(
  entry: TrackWorkInventoryEntry,
): DueWorkRebuildDefinition<string, TrackDueWorkSource> {
  return {
    project: (source, context) => projectTrackSource(entry, source, context),
    readSourceChunk: ({ after, client, limit }) =>
      readTrackDueWorkSourceChunk(client, { after, limit }),
    subjectType: "track",
    workKind: entry.workKind,
  };
}

export const TRACK_DUE_WORK_BACKFILLS =
  DUE_WORK_TRACK_WORK_KIND_INVENTORY.map(trackBackfillDefinition);

type VendorSourceRow = Row & {
  added_to_spotify: bigint | null | number;
  apple_music_attempted_at: null | string;
  apple_music_done_at: null | string;
  apple_music_failures: bigint | null | number;
  apple_music_url: null | string;
  artist_credits_backfilled_at: null | string;
  artist_edges_backfilled_at: null | string;
  artists_json: string;
  beatport_attempted_at: null | string;
  beatport_done_at: null | string;
  beatport_failures: bigint | null | number;
  beatport_url: null | string;
  capture_priority: bigint | null | number;
  capture_status: null | string;
  capture_verification: null | string;
  catalogue_rank_corpus: null | string;
  deezer_attempted_at: null | string;
  deezer_failures: bigint | null | number;
  deezer_track_id: null | string;
  dismissed_at: null | string;
  discogs_attempted_at: null | string;
  discogs_done_at: null | string;
  discogs_failures: bigint | null | number;
  duration_ms: bigint | null | number;
  finding_added_at: null | string;
  finding_track_id: null | string;
  has_artist_edge: bigint | number;
  has_embedding: bigint | number;
  in_release_id: bigint | null | number;
  is_catalogue: bigint | number;
  isrc: null | string;
  isrc_attempted_at: null | string;
  lastfm_attempted_at: null | string;
  lastfm_done_at: null | string;
  lastfm_failures: bigint | null | number;
  mb_recording_id: null | string;
  mb_recording_id_attempted_at: null | string;
  posted_to_telegram: bigint | null | number;
  source_audio_key: null | string;
  title: string;
  track_id: string;
};

const VENDOR_SOURCE_SELECT = `select
  t.apple_music_url, t.artist_credits_backfilled_at, t.artist_edges_backfilled_at,
  t.artists_json, t.beatport_url, t.capture_priority, t.capture_status,
  t.capture_verification, t.catalogue_rank_corpus, t.deezer_track_id, t.dismissed_at,
  t.duration_ms, t.has_embedding, t.in_release_id, t.is_catalogue, t.isrc,
  t.isrc_attempted_at, t.mb_recording_id, t.mb_recording_id_attempted_at,
  t.source_audio_key, t.title, t.track_id,
  t.backfill_apple_music_attempted_at as apple_music_attempted_at,
  t.backfill_apple_music_done_at as apple_music_done_at,
  t.backfill_apple_music_failures as apple_music_failures,
  t.backfill_beatport_attempted_at as beatport_attempted_at,
  t.backfill_beatport_done_at as beatport_done_at,
  t.backfill_beatport_failures as beatport_failures,
  t.backfill_deezer_attempted_at as deezer_attempted_at,
  t.backfill_deezer_failures as deezer_failures,
  f.added_at as finding_added_at, f.added_to_spotify, f.posted_to_telegram,
  f.backfill_discogs_attempted_at as discogs_attempted_at,
  f.backfill_discogs_done_at as discogs_done_at,
  f.backfill_discogs_failures as discogs_failures,
  f.backfill_lastfm_attempted_at as lastfm_attempted_at,
  f.backfill_lastfm_done_at as lastfm_done_at,
  f.backfill_lastfm_failures as lastfm_failures,
  f.track_id as finding_track_id,
  exists(select 1 from track_artists ta where ta.track_id = t.track_id) as has_artist_edge
from tracks t
left join findings f on f.track_id = t.track_id`;

export async function refreshDueWorkCatalogueRankCorpus(client: DueWorkClient): Promise<string> {
  const counts = await client.execute(`select
    (select count(*) from findings) as findings,
    (select count(*) from findings cross join tracks ft on ft.track_id = findings.track_id
      where ft.has_embedding = 1) as embedded`);
  const countRow = counts.rows[0] as
    | { embedded: bigint | number; findings: bigint | number }
    | undefined;
  const artistIds = await readQualifiedArtistIds(client, QUALIFIED_ARTISTS_SQL);
  const corpus = rankCorpus(
    Number(countRow?.findings ?? 0),
    Number(countRow?.embedded ?? 0),
    artistIds.length,
    qualifiedArtistsDigest(artistIds),
  );
  await client.execute({
    args: [
      CATALOGUE_RANK_STATE_KEY,
      JSON.stringify({
        corpus,
        embeddedFindings: Number(countRow?.embedded ?? 0),
        findings: Number(countRow?.findings ?? 0),
      }),
    ],
    sql: `insert into settings (key, value) values (?, ?)
      on conflict(key) do update set value = excluded.value`,
  });
  return corpus;
}

async function readCatalogueRankCorpus(client: DueWorkClient): Promise<string> {
  const cached = await client.execute({
    args: [CATALOGUE_RANK_STATE_KEY],
    sql: `select value from settings where key = ? limit 1`,
  });
  const value = cached.rows[0]?.value;
  const corpus = parseCatalogueRankState(typeof value === "string" ? value : undefined)?.corpus;
  return corpus ?? (await refreshDueWorkCatalogueRankCorpus(client));
}

function discogsUrl(releaseId: bigint | null | number): null | string {
  return releaseId === null ? null : `https://www.discogs.com/release/${Number(releaseId)}`;
}

function vendorSource(row: VendorSourceRow): DueWorkVendorSource {
  return {
    addedToSpotify: booleanValue(row.added_to_spotify),
    appleMusicAttemptedAt: row.apple_music_attempted_at,
    appleMusicDoneAt: row.apple_music_done_at,
    appleMusicFailures: numberOrNull(row.apple_music_failures),
    appleMusicUrl: row.apple_music_url,
    artistCreditsBackfilledAt: row.artist_credits_backfilled_at,
    artistEdgesBackfilledAt: row.artist_edges_backfilled_at,
    artists: parseArtistsJson(row.artists_json),
    beatportAttemptedAt: row.beatport_attempted_at,
    beatportDoneAt: row.beatport_done_at,
    beatportFailures: numberOrNull(row.beatport_failures),
    beatportUrl: row.beatport_url,
    capturePriority: numberOrNull(row.capture_priority),
    captureStatus: row.capture_status,
    captureVerification: row.capture_verification,
    catalogueRankCorpus: row.catalogue_rank_corpus,
    certified: row.finding_track_id !== null,
    deezerAttemptedAt: row.deezer_attempted_at,
    deezerFailures: numberOrNull(row.deezer_failures),
    deezerTrackId: row.deezer_track_id,
    discogsAttemptedAt: row.discogs_attempted_at,
    discogsDoneAt: row.discogs_done_at,
    discogsFailures: numberOrNull(row.discogs_failures),
    discogsReleaseUrl: discogsUrl(row.in_release_id),
    dismissedAt: row.dismissed_at,
    durationMs: numberOrNull(row.duration_ms),
    findingAddedAt: row.finding_added_at,
    hasArtistEdge: booleanValue(row.has_artist_edge),
    hasEmbedding: booleanValue(row.has_embedding),
    isCatalogue: booleanValue(row.is_catalogue),
    isrc: row.isrc,
    isrcAttemptedAt: row.isrc_attempted_at,
    lastfmAttemptedAt: row.lastfm_attempted_at,
    lastfmDoneAt: row.lastfm_done_at,
    lastfmFailures: numberOrNull(row.lastfm_failures),
    mbRecordingId: row.mb_recording_id,
    mbRecordingIdAttemptedAt: row.mb_recording_id_attempted_at,
    postedToTelegram: booleanValue(row.posted_to_telegram),
    sourceAudioKey: row.source_audio_key,
    title: row.title,
    trackId: row.track_id,
  };
}

export type VendorDueWorkSource = DueWorkVendorSource & {
  cursor: string;
  rankCorpus?: string;
  sourceVersion: string;
  subjectId: string;
};

async function vendorSources(
  client: DueWorkClient,
  kind: DueWorkVendorKind,
  rows: readonly Row[],
): Promise<VendorDueWorkSource[]> {
  const currentRankCorpus =
    kind === "catalogue-rank" ? await readCatalogueRankCorpus(client) : undefined;
  return (rows as VendorSourceRow[]).map((row) => {
    const source = vendorSource(row);
    return {
      ...source,
      cursor: source.trackId,
      rankCorpus: currentRankCorpus,
      sourceVersion: dueWorkVendorSourceVersion(source, kind, currentRankCorpus),
      subjectId: source.trackId,
    };
  });
}

export async function readVendorDueWorkSourceChunk(
  client: DueWorkClient,
  kind: DueWorkVendorKind,
  options: { after: null | string; limit: number },
): Promise<VendorDueWorkSource[]> {
  const result = await client.execute({
    args: [options.after ?? "", options.limit],
    sql: `${VENDOR_SOURCE_SELECT}
      where t.track_id > ?
      order by t.track_id
      limit ?`,
  });
  return vendorSources(client, kind, result.rows);
}

export async function readVendorDueWorkSource(
  client: DueWorkClient,
  kind: DueWorkVendorKind,
  trackId: string,
): Promise<VendorDueWorkSource | undefined> {
  const result = await client.execute({
    args: [trackId],
    sql: `${VENDOR_SOURCE_SELECT} where t.track_id = ? limit 1`,
  });
  return (await vendorSources(client, kind, result.rows))[0];
}

type VendorInventoryEntry = (typeof DUE_WORK_VENDOR_WORK_KIND_INVENTORY)[number];

function projectVendorSource(
  entry: VendorInventoryEntry,
  source: VendorDueWorkSource,
  context: { generation: string; now: string },
): DueWorkProjection<string> | null {
  const row = evaluateDueWorkVendorQueue({
    kind: entry.workKind,
    now: context.now,
    rankCorpus: source.rankCorpus,
    sources: [source],
  })[0];
  return row === undefined
    ? null
    : projectionFromRow(
        row,
        {
          generation: context.generation,
          subjectId: source.trackId,
          subjectType: "track",
          workKind: entry.workKind,
        },
        context.now,
      );
}

function vendorBackfillDefinition(
  entry: VendorInventoryEntry,
): DueWorkRebuildDefinition<string, VendorDueWorkSource> {
  return {
    project: (source, context) => projectVendorSource(entry, source, context),
    readSourceChunk: ({ after, client, limit }) =>
      readVendorDueWorkSourceChunk(client, entry.workKind, { after, limit }),
    subjectType: "track",
    workKind: entry.workKind,
  };
}

export const VENDOR_DUE_WORK_BACKFILLS =
  DUE_WORK_VENDOR_WORK_KIND_INVENTORY.map(vendorBackfillDefinition);

type FindingSourceSnapshot = FindingRenderSource & {
  enrichment_status: null | string;
  note: null | string;
  updated_at: null | string;
};
type EntityRegistrySource<Kind extends DueWorkEntityKind> = DueWorkRebuildSource & {
  value: DueWorkSourceByKind[Kind];
};
type EntitySourceReader<Kind extends DueWorkEntityKind> = {
  readMany: (
    client: DueWorkClient,
    subjectIds: readonly string[],
  ) => Promise<EntityRegistrySource<Kind>[]>;
  readOne: (
    client: DueWorkClient,
    subjectId: string,
  ) => Promise<EntityRegistrySource<Kind> | undefined>;
  readSourceChunk: (
    client: DueWorkClient,
    options: { after: null | string; limit: number },
  ) => Promise<EntityRegistrySource<Kind>[]>;
};
type EntityDefinitionConfig<Kind extends DueWorkEntityKind> = EntitySourceReader<Kind> & {
  evaluate: (source: DueWorkSourceByKind[Kind], now: string) => DueWorkEntityRow | null;
  kind: Kind;
  subjectType: DueWorkSubjectType;
};

function entityRegistrySource<Kind extends DueWorkEntityKind>(
  kind: Kind,
  cursor: string,
  subjectId: string,
  value: DueWorkSourceByKind[Kind],
): EntityRegistrySource<Kind> {
  return {
    cursor,
    sourceVersion: dueWorkEntitySourceVersion(kind, value),
    subjectId,
    value,
  };
}

const FINDING_SOURCE_SELECT = `select track_id, enrichment_status, updated_at, added_at,
  context_note, context_status, note, observation_audio_url, video_url
from findings`;

function findingReader<Kind extends Extract<DueWorkEntityKind, `finding.${string}`>>(
  kind: Kind,
): EntitySourceReader<Kind> {
  const wrap = (row: Row): EntityRegistrySource<Kind> => {
    const snapshot = row as unknown as FindingSourceSnapshot;
    return entityRegistrySource(
      kind,
      snapshot.track_id,
      snapshot.track_id,
      snapshot as DueWorkSourceByKind[Kind],
    );
  };
  return {
    async readMany(client, subjectIds) {
      if (subjectIds.length === 0) {
        return [];
      }
      const placeholders = subjectIds.map(() => "?").join(", ");
      const result = await client.execute({
        args: [...subjectIds],
        sql: `${FINDING_SOURCE_SELECT} where track_id in (${placeholders})`,
      });
      return result.rows.map(wrap);
    },
    async readOne(client, subjectId) {
      const result = await client.execute({
        args: [subjectId],
        sql: `${FINDING_SOURCE_SELECT} where track_id = ? limit 1`,
      });
      const row = result.rows[0];
      return row === undefined ? undefined : wrap(row);
    },
    async readSourceChunk(client, options) {
      const result = await client.execute({
        args: [options.after ?? "", options.limit],
        sql: `${FINDING_SOURCE_SELECT} where track_id > ? order by track_id limit ?`,
      });
      return result.rows.map(wrap);
    },
  };
}

function entityBioReader<Kind extends "album.bio" | "artist.bio" | "label.bio">(
  kind: Kind,
  table: "albums" | "artists" | "labels",
): EntitySourceReader<Kind> {
  const select = `select id, bio, certified_finding_count, renderable_track_count, created_at from ${table}`;
  const wrap = (row: Row): EntityRegistrySource<Kind> => {
    const value = row as unknown as EntityBioSource;
    return entityRegistrySource(kind, value.id, value.id, value);
  };
  return primaryKeyReader(select, "id", wrap);
}

function primaryKeyReader<Kind extends DueWorkEntityKind>(
  select: string,
  repairColumn: "id" | "slug",
  wrap: (row: Row) => EntityRegistrySource<Kind>,
): EntitySourceReader<Kind> {
  return {
    async readMany(client, subjectIds) {
      if (subjectIds.length === 0) {
        return [];
      }
      const placeholders = subjectIds.map(() => "?").join(", ");
      const result = await client.execute({
        args: [...subjectIds],
        sql: `${select} where ${repairColumn} in (${placeholders})`,
      });
      return result.rows.map(wrap);
    },
    async readOne(client, subjectId) {
      const result = await client.execute({
        args: [subjectId],
        sql: `${select} where ${repairColumn} = ? limit 1`,
      });
      const row = result.rows[0];
      return row === undefined ? undefined : wrap(row);
    },
    async readSourceChunk(client, options) {
      const result = await client.execute({
        args: [options.after ?? "", options.limit],
        sql: `${select} where id > ? order by id limit ?`,
      });
      return result.rows.map(wrap);
    },
  };
}

function coverMasterReader<Kind extends "album.cover-master" | "artist.cover-master">(
  kind: Kind,
  table: "albums" | "artists",
): EntitySourceReader<Kind> {
  const imageUrl = table === "artists" ? "image_url" : "null as image_url";
  const select = `select id, slug, ${imageUrl}, image_state, image_attempted_at from ${table}`;
  return primaryKeyReader(select, "slug", (row) => {
    const sourceRow = row as Row & CoverMasterSource & { id: string };
    const value: CoverMasterSource = {
      image_attempted_at: sourceRow.image_attempted_at,
      image_state: sourceRow.image_state,
      image_url: sourceRow.image_url,
      slug: sourceRow.slug,
    };
    return entityRegistrySource(kind, sourceRow.id, value.slug, value);
  });
}

function labelImageReader(): EntitySourceReader<"label.image"> {
  return primaryKeyReader(
    "select id, slug, image_state, image_attempted_at from labels",
    "slug",
    (row) => {
      const value = row as unknown as DueWorkSourceByKind["label.image"] & { id: string };
      return entityRegistrySource("label.image", value.id, value.slug, value);
    },
  );
}

function artistImageReader(): EntitySourceReader<"artist.image"> {
  return primaryKeyReader(
    "select id, image_url, spotify_artist_id, image_state from artists",
    "id",
    (row) => {
      const value = row as unknown as ArtistImageSource;
      return entityRegistrySource("artist.image", value.id, value.id, value);
    },
  );
}

function entityDefinition<Kind extends DueWorkEntityKind>(
  config: EntityDefinitionConfig<Kind>,
): {
  backfill: DueWorkRebuildDefinition<string, EntityRegistrySource<Kind>>;
  repair: (client: DueWorkClient) => DueWorkRepairDefinition<string>;
} {
  const project = (
    source: EntityRegistrySource<Kind>,
    context: { generation: string; now: string },
  ): DueWorkProjection<string> | null => {
    const row = config.evaluate(source.value, context.now);
    return row === null
      ? null
      : projectionFromRow(
          row,
          {
            generation: context.generation,
            subjectId: source.subjectId,
            subjectType: config.subjectType,
            workKind: config.kind,
          },
          context.now,
        );
  };
  return {
    backfill: {
      project,
      readSourceChunk: ({ after, client, limit }) =>
        config.readSourceChunk(client, { after, limit }),
      subjectType: config.subjectType,
      workKind: config.kind,
    },
    repair: (client) => ({
      project: async (marker) => {
        const source = await config.readOne(client, marker.subjectId);
        return source === undefined
          ? null
          : repairProjection(project(source, markerContext(marker)));
      },
      projectMany: async (markers) => {
        const sources = await config.readMany(
          client,
          markers.map((marker) => marker.subjectId),
        );
        const bySubjectId = new Map(sources.map((source) => [source.subjectId, source]));
        return markers.map((marker) => {
          const source = bySubjectId.get(marker.subjectId);
          return source === undefined
            ? null
            : repairProjection(project(source, markerContext(marker)));
        });
      },
      subjectType: config.subjectType,
      workKind: config.kind,
    }),
  };
}

const ENTITY_DEFINITIONS = [
  entityDefinition({
    ...findingReader("finding.enrich"),
    evaluate: evaluateFindingEnrich,
    kind: "finding.enrich",
    subjectType: "track",
  }),
  entityDefinition({
    ...findingReader("finding.context"),
    evaluate: evaluateFindingContextNormal,
    kind: "finding.context",
    subjectType: "track",
  }),
  entityDefinition({
    ...findingReader("finding.context.retry-empty"),
    evaluate: evaluateFindingContextRetryEmpty,
    kind: "finding.context.retry-empty",
    subjectType: "track",
  }),
  entityDefinition({
    ...findingReader("finding.note"),
    evaluate: evaluateFindingNote,
    kind: "finding.note",
    subjectType: "track",
  }),
  entityDefinition({
    ...findingReader("finding.observe"),
    evaluate: evaluateFindingObserve,
    kind: "finding.observe",
    subjectType: "track",
  }),
  entityDefinition({
    ...findingReader("finding.render"),
    evaluate: evaluateFindingRenderNormal,
    kind: "finding.render",
    subjectType: "track",
  }),
  entityDefinition({
    ...findingReader("finding.render.requires-observation"),
    evaluate: evaluateFindingRenderRequiresObservation,
    kind: "finding.render.requires-observation",
    subjectType: "track",
  }),
  entityDefinition({
    ...entityBioReader("artist.bio", "artists"),
    evaluate: evaluateArtistBio,
    kind: "artist.bio",
    subjectType: "artist",
  }),
  entityDefinition({
    ...entityBioReader("album.bio", "albums"),
    evaluate: evaluateAlbumBio,
    kind: "album.bio",
    subjectType: "album",
  }),
  entityDefinition({
    ...entityBioReader("label.bio", "labels"),
    evaluate: evaluateLabelBio,
    kind: "label.bio",
    subjectType: "label",
  }),
  entityDefinition({
    ...coverMasterReader("artist.cover-master", "artists"),
    evaluate: evaluateArtistCoverMaster,
    kind: "artist.cover-master",
    subjectType: "artist",
  }),
  entityDefinition({
    ...coverMasterReader("album.cover-master", "albums"),
    evaluate: evaluateAlbumCoverMaster,
    kind: "album.cover-master",
    subjectType: "album",
  }),
  entityDefinition({
    ...labelImageReader(),
    evaluate: evaluateLabelImage,
    kind: "label.image",
    subjectType: "label",
  }),
  entityDefinition({
    ...artistImageReader(),
    evaluate: evaluateArtistImage,
    kind: "artist.image",
    subjectType: "artist",
  }),
] as const;

export const ENTITY_DUE_WORK_BACKFILLS = ENTITY_DEFINITIONS.map(
  (definition) => definition.backfill,
);

export type TrackDueWorkSourceRepairProjection<Marker extends DueWorkRow<string>> = {
  marker: Marker;
  projection: DueWorkProjection<string> | null;
  workKind: string;
};

function projectFindingSourceRepair(
  kind: Extract<DueWorkEntityKind, `finding.${string}`>,
  source: FindingSourceSnapshot,
  marker: DueWorkRow<string>,
): DueWorkProjection<string> | null {
  const row = (() => {
    switch (kind) {
      case "finding.enrich":
        return evaluateFindingEnrich(source, marker.updatedAt);
      case "finding.context":
        return evaluateFindingContextNormal(source, marker.updatedAt);
      case "finding.context.retry-empty":
        return evaluateFindingContextRetryEmpty(source, marker.updatedAt);
      case "finding.note":
        return evaluateFindingNote(source, marker.updatedAt);
      case "finding.observe":
        return evaluateFindingObserve(source, marker.updatedAt);
      case "finding.render":
        return evaluateFindingRenderNormal(source, marker.updatedAt);
      case "finding.render.requires-observation":
        return evaluateFindingRenderRequiresObservation(source, marker.updatedAt);
    }
  })();
  return row === null
    ? null
    : projectionFromRow(
        row,
        {
          generation: marker.generation,
          subjectId: marker.subjectId,
          subjectType: "track",
          workKind: kind,
        },
        marker.updatedAt,
      );
}

const FINDING_DUE_WORK_KINDS = [
  "finding.enrich",
  "finding.context",
  "finding.context.retry-empty",
  "finding.note",
  "finding.observe",
  "finding.render",
  "finding.render.requires-observation",
] as const;

/** Project a source-marker page from one authoritative read per track source family. */
export async function projectTrackDueWorkSourceRepairs<Marker extends DueWorkRow<string>>(
  client: DueWorkClient,
  markers: readonly Marker[],
): Promise<TrackDueWorkSourceRepairProjection<Marker>[]> {
  if (markers.length === 0) {
    return [];
  }
  const trackIds = markers.map((marker) => marker.subjectId);
  const placeholders = trackIds.map(() => "?").join(", ");
  const trackSources = await readTrackDueWorkSources(client, trackIds);
  const vendorRows = await client.execute({
    args: trackIds,
    sql: `${VENDOR_SOURCE_SELECT} where t.track_id in (${placeholders})`,
  });
  const findingRows = await client.execute({
    args: trackIds,
    sql: `${FINDING_SOURCE_SELECT} where track_id in (${placeholders})`,
  });
  const currentRankCorpus =
    vendorRows.rows.length === 0 ? undefined : await readCatalogueRankCorpus(client);
  const vendors = new Map(
    (vendorRows.rows as VendorSourceRow[]).map((row) => {
      const source = vendorSource(row);
      return [source.trackId, source] as const;
    }),
  );
  const findings = new Map(
    (findingRows.rows as unknown as FindingSourceSnapshot[]).map((source) => [
      source.track_id,
      source,
    ]),
  );
  const projected: TrackDueWorkSourceRepairProjection<Marker>[] = [];

  for (const marker of markers) {
    const track = trackSources.get(marker.subjectId);
    for (const entry of DUE_WORK_TRACK_WORK_KIND_INVENTORY) {
      projected.push({
        marker,
        projection:
          track === undefined ? null : projectTrackSource(entry, track, markerContext(marker)),
        workKind: entry.workKind,
      });
    }

    const vendor = vendors.get(marker.subjectId);
    for (const entry of DUE_WORK_VENDOR_WORK_KIND_INVENTORY) {
      const rank = entry.workKind === "catalogue-rank" ? currentRankCorpus : undefined;
      const source: VendorDueWorkSource | undefined =
        vendor === undefined
          ? undefined
          : {
              ...vendor,
              cursor: vendor.trackId,
              rankCorpus: rank,
              sourceVersion: dueWorkVendorSourceVersion(vendor, entry.workKind, rank),
              subjectId: vendor.trackId,
            };
      projected.push({
        marker,
        projection:
          source === undefined ? null : projectVendorSource(entry, source, markerContext(marker)),
        workKind: entry.workKind,
      });
    }

    const finding = findings.get(marker.subjectId);
    for (const kind of FINDING_DUE_WORK_KINDS) {
      projected.push({
        marker,
        projection:
          finding === undefined ? null : projectFindingSourceRepair(kind, finding, marker),
        workKind: kind,
      });
    }
  }
  return projected;
}

function projectionFromRow(
  row: { nextDueAt: string; orderKey: string; sourceVersion: string },
  identity: {
    generation: string;
    subjectId: string;
    subjectType: DueWorkSubjectType;
    workKind: string;
  },
  now: string,
): DueWorkProjection<string> {
  return {
    generation: identity.generation,
    nextDueAt: row.nextDueAt,
    sortKey: row.orderKey,
    sourceVersion: row.sourceVersion,
    state: row.nextDueAt <= now ? "ready" : "scheduled",
    subjectId: identity.subjectId,
    subjectType: identity.subjectType,
    workKind: identity.workKind,
  };
}

function markerContext(marker: DueWorkRow<string>): { generation: string; now: string } {
  return { generation: marker.generation, now: marker.updatedAt };
}

function repairProjection(
  projection: DueWorkProjection<string> | null,
): DueWorkProjection<string> | null {
  return projection;
}

export function trackDueWorkRepairDefinitions(
  client: DueWorkClient,
): DueWorkRepairDefinition<string>[] {
  return DUE_WORK_TRACK_WORK_KIND_INVENTORY.map((entry) => ({
    project: async (marker) => {
      const source = await readTrackDueWorkSource(client, marker.subjectId);
      return source === undefined
        ? null
        : repairProjection(projectTrackSource(entry, source, markerContext(marker)));
    },
    projectMany: async (markers) => {
      const sources = await readTrackDueWorkSources(
        client,
        markers.map((marker) => marker.subjectId),
      );
      return markers.map((marker) => {
        const source = sources.get(marker.subjectId);
        return source === undefined
          ? null
          : repairProjection(projectTrackSource(entry, source, markerContext(marker)));
      });
    },
    subjectType: "track",
    workKind: entry.workKind,
  }));
}

export function vendorDueWorkRepairDefinitions(
  client: DueWorkClient,
): DueWorkRepairDefinition<string>[] {
  return DUE_WORK_VENDOR_WORK_KIND_INVENTORY.map((entry) => ({
    project: async (marker) => {
      const source = await readVendorDueWorkSource(client, entry.workKind, marker.subjectId);
      return source === undefined
        ? null
        : repairProjection(projectVendorSource(entry, source, markerContext(marker)));
    },
    projectMany: async (markers) => {
      if (markers.length === 0) {
        return [];
      }
      const trackIds = markers.map((marker) => marker.subjectId);
      const placeholders = trackIds.map(() => "?").join(", ");
      const result = await client.execute({
        args: trackIds,
        sql: `${VENDOR_SOURCE_SELECT} where t.track_id in (${placeholders})`,
      });
      const sources = new Map(
        (await vendorSources(client, entry.workKind, result.rows)).map((source) => [
          source.trackId,
          source,
        ]),
      );
      return markers.map((marker) => {
        const source = sources.get(marker.subjectId);
        return source === undefined
          ? null
          : repairProjection(projectVendorSource(entry, source, markerContext(marker)));
      });
    },
    subjectType: "track",
    workKind: entry.workKind,
  }));
}

export function entityDueWorkRepairDefinitions(
  client: DueWorkClient,
): DueWorkRepairDefinition<string>[] {
  return ENTITY_DEFINITIONS.map((definition) => definition.repair(client));
}

function registeredDefinition<Source extends DueWorkRebuildSource>(
  definition: DueWorkRebuildDefinition<string, Source>,
): DueWorkRebuildDefinition<string, DueWorkRebuildSource> {
  return {
    project: (source, context) => definition.project(source as Source, context),
    readSourceChunk: definition.readSourceChunk,
    subjectType: definition.subjectType,
    workKind: definition.workKind,
  };
}

/** Complete, machine-checkable inventory consumed by the local rebuild script. */
export const DUE_WORK_BACKFILLS: readonly DueWorkRebuildDefinition<string, DueWorkRebuildSource>[] =
  [
    ...TRACK_DUE_WORK_BACKFILLS.map(registeredDefinition),
    ...VENDOR_DUE_WORK_BACKFILLS.map(registeredDefinition),
    ...ENTITY_DUE_WORK_BACKFILLS.map((definition) =>
      registeredDefinition(
        definition as unknown as DueWorkRebuildDefinition<string, DueWorkRebuildSource>,
      ),
    ),
  ];

export function dueWorkRepairDefinitions(client: DueWorkClient): DueWorkRepairDefinition<string>[] {
  return [
    ...trackDueWorkRepairDefinitions(client),
    ...vendorDueWorkRepairDefinitions(client),
    ...entityDueWorkRepairDefinitions(client),
  ];
}

export const DUE_WORK_REGISTERED_KINDS = [
  ...DUE_WORK_TRACK_WORK_KIND_INVENTORY.map((entry) => entry.workKind),
  ...DUE_WORK_VENDOR_WORK_KIND_INVENTORY.map((entry) => entry.workKind),
  ...DUE_WORK_KINDS,
] as const;
