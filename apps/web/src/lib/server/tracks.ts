import { SONIC_SEED_SELECT, sonicSeedFlag } from "./sonic-seed";
import {
  type FeedListPage,
  type MixArtist,
  type MixCandidate as MixCandidateDTO,
  type MixReason,
  type MixTrack as MixTrackDTO,
  type TrackCursor,
  type TrackFeatures,
  type TrackListPage,
  type TrackListItem,
} from "@fluncle/contracts";
import { logPageUrl } from "../fluncle-links";
import { bestAlbumCoverUrl, versionedObservationAudioUrl } from "../media";
import { hasPreviewSource } from "../track-preview";
import { nextBoundaryEpochMs, type RadioScheduleEntry } from "../radio-schedule";
import { type FeedItem, type MixtapeMember, rowToMixtape } from "../mixtapes";
import { composeAppleArtworkUrl } from "./apple-music";
import { parseArtistsJson } from "./artists";
import { getDb, typedRow, typedRows } from "./db";
import { artistCandidateIdsSql } from "./artist-membership";
import { releasedByTodaySql } from "./release-day";
import { countDueWorkNow } from "./due-work";
import { discogsReleaseUrl } from "./discogs";
import { isDueWorkCutoverEnabled, readPromotedDueWorkPage } from "./due-work-cutover";
import { encodeDueWorkOrder } from "./due-work-order";
import { cosineFromDistance, readEmbeddingBlob, toVectorProbe } from "./embedding";
import { readKeyHistogram } from "./key-histogram";
import { logEvent } from "./log";
import { readMixableArtistsProjection } from "./mixable-artists-projection";
import { isSonarLogEnabled, isSonarMixEnabled, searchSonar, type SonarMatch } from "./sonar";
import { hydrateRankedSonarMatches } from "./sonar-hydration";
import {
  executeVectorFallback,
  isVectorDeadlineExpired,
  raceWithDeadline,
  vectorFallbackCandidateLimitSql,
} from "./vector-fallback";
import { MIX_RAIL_DEADLINE_MS, MIX_RAIL_SCAN_DEADLINE_MS } from "../vector-budget";
import { isLogId } from "../log-id";
import { dedupeByRecordingIdentity } from "./track-match";
import { FINDING_TRACK_OR_LOG_ID_CTE, TRACK_OR_LOG_ID_CTE } from "./track-id-resolver";
import {
  applyTaste,
  type MixCandidate as RankCandidate,
  type MixChainDepth,
  mixChainDepth,
  type MixTrack as RankTrack,
  namedMoveClasses,
  orderMixPath,
  rankMixable,
  RAIL_DEPTH,
  scoreMix,
  shortlistMixable,
  sonicGateOpen,
  TASTE_SHORTLIST,
  tasteSubScore,
  toMixTrack,
} from "./mixability";
import { type Camelot, keyToCamelotCode, parseKey, toCamelot } from "../key-camelot";
import { extractYoutubeChannelId } from "./youtube";
import {
  catalogueTrackDurationWhere,
  publicTrackDurationWhere,
} from "../../db/public-track-visibility";

export type { FeedListPage, TrackCursor, TrackFeatures, TrackListPage, TrackListItem };
export type { RadioScheduleEntry };

export type TrackRow = {
  added_at: string;
  sonic_seed?: number | null;
  album: string | null;

  album_artwork_height: number | null;
  album_artwork_url_template: string | null;
  album_artwork_width: number | null;
  album_image_url: string | null;

  album_image_key: string | null;
  album_image_state: string | null;
  album_image_updated_at: string | null;

  album_slug: string | null;

  analyzed_at: string | null;

  analyzed_from: string | null;

  apple_music_url: string | null;
  artists_json: string;
  bpm: number | null;

  bpm_source: string | null;
  duration_ms: number;
  enrichment_status: string;
  features_json: string | null;

  galaxy_name: string | null;
  galaxy_slug: string | null;
  in_release_id: number | null;
  isrc: string | null;
  key: string | null;

  key_source: string | null;
  label: string | null;

  label_slug: string | null;
  log_id: string | null;

  mb_recording_id: string | null;
  note: string | null;
  observation_alignment_json: string | null;
  observation_audio_url: string | null;
  observation_duration_ms: number | null;
  observation_generated_at: string | null;
  popularity: number | null;
  preview_url: string | null;
  release_date: string | null;
  source_audio_failures: number;
  source_audio_key: string | null;
  spotify_url: string;
  tiktok_url: string | null;
  youtube_url: string | null;
  title: string;
  track_id: string;
  updated_at: string | null;
  video_grain: string | null;
  video_model: string | null;
  video_model_reasoning: string | null;
  video_palette: string | null;
  video_plate_subject: string | null;
  video_register: string | null;
  video_squared_at: string | null;
  video_structure: string | null;
  video_url: string | null;
  video_vehicle: string | null;
  added_to_spotify: number;
  posted_to_telegram: number;
};

type MixtapeFeedRow = {
  added_at: string;
  duration_ms: number | null;
  id: string;
  log_id: string;
  member_count: number;
  mixcloud_url: string | null;
  note: string | null;
  sequence_number: number | null;
  soundcloud_url: string | null;
  title: string;
  updated_at: string | null;
  youtube_url: string | null;
};

export const FINDINGS_FROM = `findings join tracks on tracks.track_id = findings.track_id`;

export const TRACK_SELECT = `tracks.track_id, tracks.spotify_url, tracks.apple_music_url, tracks.title, tracks.album, tracks.album_image_url, tracks.artists_json, tracks.analyzed_at, tracks.analyzed_from,
  tracks.bpm, tracks.bpm_source, tracks.duration_ms, findings.enrichment_status, tracks.features_json, tracks.in_release_id, tracks.isrc, tracks.key, tracks.key_source, tracks.label, tracks.mb_recording_id, findings.log_id, tracks.popularity,
  tracks.preview_url, tracks.release_date, tracks.source_audio_failures, tracks.source_audio_key, findings.video_url, findings.video_squared_at, findings.video_vehicle, findings.video_grain, findings.video_register, findings.video_palette, findings.video_plate_subject, findings.video_structure, findings.video_model, findings.video_model_reasoning, findings.note, findings.added_at,
  findings.updated_at, findings.added_to_spotify, findings.posted_to_telegram,
  findings.observation_audio_url, findings.observation_duration_ms, findings.observation_generated_at, findings.observation_alignment_json,
  (select name from galaxies where galaxies.id = findings.galaxy_id) as galaxy_name,
  (select slug from galaxies where galaxies.id = findings.galaxy_id) as galaxy_slug,
  (select slug from albums where albums.id = tracks.album_id) as album_slug,
  (select artwork_url_template from albums where albums.id = tracks.album_id) as album_artwork_url_template,
  (select artwork_width from albums where albums.id = tracks.album_id) as album_artwork_width,
  (select artwork_height from albums where albums.id = tracks.album_id) as album_artwork_height,
  (select image_key from albums where albums.id = tracks.album_id) as album_image_key,
  (select image_state from albums where albums.id = tracks.album_id) as album_image_state,
  (select image_updated_at from albums where albums.id = tracks.album_id) as album_image_updated_at,
  (select slug from labels where labels.id = tracks.label_id) as label_slug,
  (select url from social_posts
     where track_id = tracks.track_id and platform = 'tiktok' and status = 'published'
       and url is not null
     order by published_at desc limit 1) as tiktok_url,
  (select url from social_posts
     where track_id = tracks.track_id and platform = 'youtube' and status = 'published'
       and url is not null
     order by published_at desc limit 1) as youtube_url,
  ${SONIC_SEED_SELECT}`;

const LEAN_LIST_OMITTED_COLUMNS = new Set([
  "tracks.features_json",
  "findings.observation_alignment_json",
  "findings.video_model_reasoning",
]);

const LEAN_OMITTED_SUBQUERY_ALIASES = new Set([
  "album_artwork_height",
  "album_artwork_url_template",
  "album_artwork_width",
]);

function deriveTrackSelect(omittedColumns: Set<string>, omittedAliases: Set<string>): string {
  return TRACK_SELECT.split(",")
    .filter((fragment) => {
      const trimmed = fragment.trim();

      if (omittedColumns.has(trimmed)) {
        return false;
      }

      const alias = /\bas\s+([a-z_]+)\s*$/i.exec(trimmed)?.[1];

      return alias === undefined || !omittedAliases.has(alias);
    })
    .join(",");
}

export const LEAN_TRACK_SELECT = deriveTrackSelect(
  LEAN_LIST_OMITTED_COLUMNS,
  LEAN_OMITTED_SUBQUERY_ALIASES,
);

const BOARD_OMITTED_SUBQUERY_ALIASES = new Set([
  "album_slug",
  "galaxy_name",
  "galaxy_slug",
  "label_slug",
  "sonic_seed",
  "youtube_url",
]);
const BOARD_TRACK_SELECT = deriveTrackSelect(
  LEAN_LIST_OMITTED_COLUMNS,
  new Set([...LEAN_OMITTED_SUBQUERY_ALIASES, ...BOARD_OMITTED_SUBQUERY_ALIASES]),
);

const GRAPH_OMITTED_SUBQUERY_ALIASES = new Set([
  "album_slug",
  "label_slug",
  "tiktok_url",
  "youtube_url",
]);
const GRAPH_TRACK_SELECT = deriveTrackSelect(
  LEAN_LIST_OMITTED_COLUMNS,
  new Set([...LEAN_OMITTED_SUBQUERY_ALIASES, ...GRAPH_OMITTED_SUBQUERY_ALIASES]),
);

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseObservationAlignment(
  json: string | null,
): { words: { endMs: number; startMs: number; text: string }[] } | undefined {
  if (!json) {
    return undefined;
  }

  try {
    const raw = JSON.parse(json) as { words?: unknown };

    if (!Array.isArray(raw.words)) {
      return undefined;
    }

    const words = raw.words.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return [];
      }

      const word = entry as {
        end?: unknown;
        endMs?: unknown;
        start?: unknown;
        startMs?: unknown;
        text?: unknown;
      };
      const text = typeof word.text === "string" ? word.text : "";
      const startMs = finiteOrUndefined(word.startMs);
      const endMs = finiteOrUndefined(word.endMs);

      if (!text || /[<>]|="/.test(text) || startMs === undefined || endMs === undefined) {
        return [];
      }

      return [{ endMs, startMs, text }];
    });

    return words.length > 0 ? { words } : undefined;
  } catch (error) {
    logEvent("warn", "tracks.parse-observation-alignment-failed", { error });
    return undefined;
  }
}

function parseFeatures(json: string | null): TrackFeatures | undefined {
  if (!json) {
    return undefined;
  }
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const features: TrackFeatures = {
      centroidHz: finiteOrUndefined(raw.centroidHz),
      highRatio: finiteOrUndefined(raw.highRatio),
      midFlatness: finiteOrUndefined(raw.midFlatness),
      onsetRate: finiteOrUndefined(raw.onsetRate),
      subBassRatio: finiteOrUndefined(raw.subBassRatio),
    };
    return Object.values(features).some((v) => v !== undefined) ? features : undefined;
  } catch (error) {
    logEvent("warn", "tracks.parse-features-failed", { error });
    return undefined;
  }
}

function galaxyOf(
  name: string | null,
  slug: string | null,
): { name: string; slug: string } | undefined {
  return name && slug ? { name, slug } : undefined;
}

function analyzedFromOf(value: string | null): "full" | "preview" | undefined {
  return value === "full" || value === "preview" ? value : undefined;
}

export type LeanTrackListItem = Omit<
  TrackListItem,
  "features" | "observationAlignment" | "videoModelReasoning"
>;

type LeanTrackRow = Omit<
  TrackRow,
  "features_json" | "observation_alignment_json" | "video_model_reasoning"
>;

function leanVideoFields(row: LeanTrackRow) {
  return {
    videoGrain: row.video_grain ?? undefined,
    videoModel: row.video_model ?? undefined,
    videoPalette: row.video_palette ?? undefined,
    videoPlateSubject: row.video_plate_subject ?? undefined,
    videoRegister: row.video_register ?? undefined,
    videoSquaredAt: row.video_squared_at ?? undefined,
    videoStructure: row.video_structure ?? undefined,
    videoUrl: row.video_url ?? undefined,
    videoVehicle: row.video_vehicle ?? undefined,
  };
}

export function toLeanTrackListItem(row: LeanTrackRow): LeanTrackListItem {
  return {
    ...leanVideoFields(row),
    addedAt: row.added_at,
    addedToSpotify: Boolean(row.added_to_spotify),
    album: row.album ?? undefined,

    albumImageUrl: bestAlbumCoverUrl({
      imageKey: row.album_image_key,
      imageState: row.album_image_state,
      imageUpdatedAt: row.album_image_updated_at,
      spotifyUrl: row.album_image_url,
    }),

    albumSlug: row.album_slug ?? undefined,

    analyzedAt: row.analyzed_at ?? undefined,
    analyzedFrom: analyzedFromOf(row.analyzed_from),

    appleMusicUrl: row.apple_music_url ?? undefined,
    artists: parseArtistsJson(row.artists_json),

    artworkMaxUrl: composeAppleArtworkUrl(
      row.album_artwork_url_template,
      row.album_artwork_width,
      row.album_artwork_height,
    ),
    bpm: row.bpm ?? undefined,

    bpmSource: row.bpm_source ?? undefined,
    discogsReleaseUrl: row.in_release_id ? discogsReleaseUrl(row.in_release_id) : undefined,
    durationMs: row.duration_ms,
    enrichmentStatus: row.enrichment_status,
    galaxy: galaxyOf(row.galaxy_name, row.galaxy_slug),
    isrc: row.isrc ?? undefined,
    key: row.key ?? undefined,

    keySource: row.key_source ?? undefined,
    label: row.label ?? undefined,
    labelSlug: row.label_slug ?? undefined,
    logId: row.log_id ?? undefined,
    logPageUrl: row.log_id ? logPageUrl(row.log_id) : undefined,

    mbRecordingId: row.mb_recording_id ?? undefined,
    note: row.note?.trim() ? row.note : undefined,

    observationAudioUrl: versionedObservationAudioUrl(
      row.observation_audio_url ?? undefined,
      row.observation_generated_at ?? undefined,
    ),
    observationDurationMs: row.observation_duration_ms ?? undefined,
    observationGeneratedAt: row.observation_generated_at ?? undefined,
    popularity: row.popularity ?? undefined,
    postedToTelegram: Boolean(row.posted_to_telegram),
    previewUrl: row.preview_url ?? undefined,
    releaseDate: row.release_date ?? undefined,
    similar: sonicSeedFlag(row.sonic_seed),
    sourceAudioFailures: row.source_audio_failures > 0 ? row.source_audio_failures : undefined,

    sourceAudioKey: row.source_audio_key ?? undefined,
    spotifyUrl: row.spotify_url,
    tiktokUrl: row.tiktok_url ?? undefined,
    title: row.title,
    trackId: row.track_id,
    type: "finding",
    updatedAt: row.updated_at ?? undefined,
    youtubeUrl: row.youtube_url ?? undefined,
  };
}

export function toTrackListItem(row: TrackRow): TrackListItem {
  return {
    ...toLeanTrackListItem(row),
    features: parseFeatures(row.features_json),
    observationAlignment: parseObservationAlignment(row.observation_alignment_json),
    videoModelReasoning: row.video_model_reasoning ?? undefined,
  };
}

export type BoardTrackListItem = Omit<
  LeanTrackListItem,
  "albumSlug" | "artworkMaxUrl" | "galaxy" | "labelSlug" | "youtubeUrl"
>;

export function toBoardTrackListItem(row: LeanTrackRow): BoardTrackListItem {
  const {
    albumSlug: _albumSlug,
    artworkMaxUrl: _artworkMaxUrl,
    galaxy: _galaxy,
    labelSlug: _labelSlug,
    youtubeUrl: _youtubeUrl,
    ...board
  } = toLeanTrackListItem(row);

  return board;
}

export type BoardTrackListPage = Omit<TrackListPage, "tracks"> & { tracks: BoardTrackListItem[] };

export type GraphFindingItem = Omit<
  LeanTrackListItem,
  "albumSlug" | "labelSlug" | "tiktokUrl" | "youtubeUrl"
>;

export function toGraphFindingItem(row: LeanTrackRow): GraphFindingItem {
  const {
    albumSlug: _albumSlug,
    labelSlug: _labelSlug,
    tiktokUrl: _tiktokUrl,
    youtubeUrl: _youtubeUrl,
    ...graph
  } = toLeanTrackListItem(row);

  return graph;
}

const PRIVATE_TRACK_FIELDS = [
  "analyzedAt",
  "analyzedFrom",
  "bpmSource",
  "keySource",
  "sourceAudioKey",
] as const;

export function toPublicTrackListItem<T extends object>(item: T): T {
  let result = item;

  for (const field of PRIVATE_TRACK_FIELDS) {
    if ((result as Record<string, unknown>)[field] !== undefined) {
      result = { ...result, [field]: undefined };
    }
  }

  return result;
}

export async function getLivePreviewTrack(
  idOrLogId: string,
): Promise<{ artists: string[]; isrc?: string; previewUrl?: string; title: string } | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [idOrLogId, idOrLogId, idOrLogId],
    sql: `with ${TRACK_OR_LOG_ID_CTE}
          select tracks.title, tracks.artists_json, tracks.isrc, tracks.preview_url
          from resolved_track
          join tracks on tracks.track_id = resolved_track.track_id
          where ${publicTrackDurationWhere("tracks")}
          limit 1`,
  });
  const row = typedRow<{
    artists_json: string;
    isrc: null | string;
    preview_url: null | string;
    title: string;
  }>(result.rows);

  if (!row) {
    return undefined;
  }

  return {
    artists: parseArtistsJson(row.artists_json),
    isrc: row.isrc ?? undefined,
    previewUrl: row.preview_url ?? undefined,
    title: row.title,
  };
}

export async function getTrackByIdOrLogId(idOrLogId: string): Promise<TrackListItem | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [idOrLogId, idOrLogId, idOrLogId],
    sql: `with ${FINDING_TRACK_OR_LOG_ID_CTE}
          select ${TRACK_SELECT}
          from resolved_track
          join findings on findings.track_id = resolved_track.track_id
          join tracks on tracks.track_id = resolved_track.track_id
          limit 1`,
  });
  const row = typedRow<TrackRow>(result.rows);

  return row ? toTrackListItem(row) : undefined;
}

export async function getTracksByLogIds(logIds: string[]): Promise<Record<string, TrackListItem>> {
  const unique = [...new Set(logIds.filter((id) => id.trim()))];

  if (unique.length === 0) {
    return {};
  }

  const db = await getDb();
  const placeholders = unique.map(() => "?").join(", ");
  const result = await db.execute({
    args: unique,
    sql: `select ${TRACK_SELECT} from ${FINDINGS_FROM}
          where findings.log_id in (${placeholders})`,
  });

  const byLogId: Record<string, TrackListItem> = {};

  for (const row of typedRows<TrackRow>(result.rows)) {
    if (row.log_id) {
      byLogId[row.log_id] = toTrackListItem(row);
    }
  }

  return byLogId;
}

export async function getTracksByIds(trackIds: string[]): Promise<Record<string, TrackListItem>> {
  const unique = [...new Set(trackIds.filter((id) => id.trim()))];

  if (unique.length === 0) {
    return {};
  }

  const db = await getDb();
  const placeholders = unique.map(() => "?").join(", ");
  const result = await db.execute({
    args: unique,
    sql: `select ${TRACK_SELECT} from ${FINDINGS_FROM}
          where tracks.track_id in (${placeholders})`,
  });

  const byTrackId: Record<string, TrackListItem> = {};

  for (const row of typedRows<TrackRow>(result.rows)) {
    byTrackId[row.track_id] = toTrackListItem(row);
  }

  return byTrackId;
}

export async function getBoardTracksByIds(
  trackIds: string[],
): Promise<Record<string, BoardTrackListItem>> {
  const unique = [...new Set(trackIds.filter((id) => id.trim()))];

  if (unique.length === 0) {
    return {};
  }

  const db = await getDb();
  const placeholders = unique.map(() => "?").join(", ");
  const result = await db.execute({
    args: unique,
    sql: `select ${BOARD_TRACK_SELECT} from ${FINDINGS_FROM}
          where tracks.track_id in (${placeholders})`,
  });

  const byTrackId: Record<string, BoardTrackListItem> = {};

  for (const row of typedRows<TrackRow>(result.rows)) {
    byTrackId[row.track_id] = toBoardTrackListItem(row);
  }

  return byTrackId;
}

export async function getFindingsByArtist(
  artistId: string,
  artistName: string,
  today?: string,
): Promise<GraphFindingItem[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [
      artistId,
      artistName,
      today ?? "0000",
      artistName,
      ...(today === undefined ? [] : [today]),
    ],
    sql: `select ${GRAPH_TRACK_SELECT} from (
            ${artistCandidateIdsSql("?", "?", "?")}
          ) artist_tracks
          join findings on findings.track_id = artist_tracks.track_id
          join tracks on tracks.track_id = artist_tracks.track_id
          where findings.log_id is not null
            and tracks.dismissed_at is null and tracks.duplicate_of_track_id is null
            ${today === undefined ? "" : `and ${releasedByTodaySql("tracks.release_date")}`}
          order by findings.added_at desc, tracks.track_id desc`,
  });
  return typedRows<TrackRow>(result.rows).map(toGraphFindingItem);
}

export async function getGraphFindingsByIds(ids: string[]): Promise<GraphFindingItem[]> {
  if (ids.length === 0) {
    return [];
  }
  const db = await getDb();
  const placeholders = ids.map(() => "?").join(", ");
  const result = await db.execute({
    args: ids,
    sql: `select ${GRAPH_TRACK_SELECT} from ${FINDINGS_FROM}
          where tracks.track_id in (${placeholders}) and findings.log_id is not null`,
  });
  const byId = new Map(
    typedRows<TrackRow>(result.rows).map((row) => [
      row.track_id,
      toPublicTrackListItem(toGraphFindingItem(row)),
    ]),
  );
  return ids.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
}

export async function getFindingsByLabel(
  labelId: string,
  today?: string,
): Promise<GraphFindingItem[]> {
  return findingsByEntity("tracks.label_id", labelId, today);
}

export async function getFindingsByAlbum(albumId: string): Promise<GraphFindingItem[]> {
  return findingsByEntity("tracks.album_id", albumId);
}

async function findingsByEntity(
  column: "tracks.album_id" | "tracks.label_id",
  entityId: string,
  today?: string,
): Promise<GraphFindingItem[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [entityId, ...(today === undefined ? [] : [today])],
    sql: `select ${GRAPH_TRACK_SELECT} from ${FINDINGS_FROM}
          where ${column} = ? and findings.log_id is not null
            and tracks.dismissed_at is null and tracks.duplicate_of_track_id is null
            ${today === undefined ? "" : `and ${releasedByTodaySql("tracks.release_date")}`}
          order by findings.added_at desc, tracks.track_id desc`,
  });

  return typedRows<TrackRow>(result.rows).map(toGraphFindingItem);
}

export type LogIndexEntry = {
  addedAt: string;
  artists: string[];
  logId: string;
  title: string;
  trackId: string;
};

export async function listLogIndexEntries(limit = 500): Promise<LogIndexEntry[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [Math.min(Math.max(limit, 1), 1000)],
    sql: `select findings.log_id, tracks.track_id, tracks.title, tracks.artists_json, findings.added_at
          from ${FINDINGS_FROM}
          where findings.log_id is not null
          order by findings.added_at desc, tracks.track_id desc
          limit ?`,
  });

  return typedRows<{
    added_at: string;
    artists_json: string;
    log_id: string;
    title: string;
    track_id: string;
  }>(result.rows).map((row) => ({
    addedAt: row.added_at,
    artists: parseArtistsJson(row.artists_json),
    logId: row.log_id,
    title: row.title,
    trackId: row.track_id,
  }));
}

export type CatalogueTrackItem = {
  albumImageUrl?: string;
  artists: string[];
  bpm?: number;
  durationMs?: number;
  key?: string;
  previewable: boolean;
  releaseDate?: string;

  spotifyUrl: string | undefined;
  title: string;
  trackId: string;
};

export const GRAPH_PAGE_CATALOGUE_LIMIT = 100;

export type CatalogueSlice = {
  tracks: CatalogueTrackItem[];

  total: number;
};

type CatalogueTrackRow = {
  album_image_key: string | null;
  album_image_state: string | null;
  album_image_updated_at: string | null;
  album_image_url: string | null;
  artists_json: string;
  bpm: number | null;
  duration_ms: number;
  isrc: string | null;
  key: string | null;
  preview_url: string | null;
  release_date: string | null;
  spotify_url: string | null;
  title: string;
  total: number;
  track_id: string;
};

export async function listCatalogueTracksByAlbum(albumId: string): Promise<CatalogueSlice> {
  const db = await getDb();
  const result = await db.execute({
    args: [albumId, GRAPH_PAGE_CATALOGUE_LIMIT],

    sql: `select tracks.track_id, tracks.title, tracks.artists_json, tracks.spotify_url,
                 tracks.album_image_url,
                 (select image_key from albums where albums.id = tracks.album_id) as album_image_key,
                 (select image_state from albums where albums.id = tracks.album_id) as album_image_state,
                 (select image_updated_at from albums where albums.id = tracks.album_id) as album_image_updated_at,
                 tracks.duration_ms, tracks.bpm, tracks.key,
                 tracks.preview_url, tracks.isrc, tracks.release_date, count(*) over () as total
          from tracks
          left join findings on findings.track_id = tracks.track_id
          where tracks.album_id = ? and findings.track_id is null
                and ${catalogueTrackDurationWhere("tracks")}
                and tracks.duplicate_of_track_id is null and tracks.dismissed_at is null
          order by tracks.release_date is null asc, tracks.release_date desc,
                   tracks.title collate nocase asc
          limit ?`,
  });

  const rows = typedRows<CatalogueTrackRow>(result.rows);
  const deduped = dedupeByRecordingIdentity(rows, (row) => ({
    artists: parseArtistsJson(row.artists_json),
    isrc: row.isrc,
    releaseDate: row.release_date,
    spotifyUrl: row.spotify_url,
    title: row.title,
    trackId: row.track_id,
  }));
  const rawTotal = Number(rows[0]?.total ?? 0);

  return {
    total: Math.max(rawTotal - (rows.length - deduped.length), deduped.length),
    tracks: deduped.map((row) => ({
      albumImageUrl: bestAlbumCoverUrl({
        imageKey: row.album_image_key,
        imageState: row.album_image_state,
        imageUpdatedAt: row.album_image_updated_at,
        spotifyUrl: row.album_image_url,
      }),
      artists: parseArtistsJson(row.artists_json),
      bpm: row.bpm ?? undefined,
      durationMs: row.duration_ms || undefined,
      key: row.key ?? undefined,
      previewable: hasPreviewSource({ isrc: row.isrc, previewUrl: row.preview_url }),
      releaseDate: row.release_date ?? undefined,
      spotifyUrl: row.spotify_url ?? undefined,
      title: row.title,
      trackId: row.track_id,
    })),
  };
}

export async function getTrackContextNote(idOrLogId: string): Promise<string | null> {
  const db = await getDb();
  const result = await db.execute({
    args: [idOrLogId, idOrLogId, idOrLogId],
    sql: `with ${FINDING_TRACK_OR_LOG_ID_CTE}
          select findings.context_note from resolved_track
          join findings on findings.track_id = resolved_track.track_id
          limit 1`,
  });
  const row = typedRow<{ context_note: string | null }>(result.rows);

  return row ? (row.context_note ?? null) : null;
}

export async function getObservationProvenance(
  idOrLogId: string,
): Promise<{ promptVersion: number | null; script: string | null }> {
  const db = await getDb();
  const result = await db.execute({
    args: [idOrLogId, idOrLogId, idOrLogId],
    sql: `with ${FINDING_TRACK_OR_LOG_ID_CTE}
          select findings.observation_script, findings.observation_prompt_version
          from resolved_track
          join findings on findings.track_id = resolved_track.track_id
          limit 1`,
  });
  const row = typedRow<{
    observation_prompt_version: number | null;
    observation_script: string | null;
  }>(result.rows);

  return {
    promptVersion: row?.observation_prompt_version ?? null,
    script: row?.observation_script ?? null,
  };
}

export async function getSourceAudioKey(idOrLogId: string): Promise<string | null> {
  const db = await getDb();
  const result = await db.execute({
    args: [idOrLogId, idOrLogId, idOrLogId],

    sql: `with ${TRACK_OR_LOG_ID_CTE}
          select tracks.source_audio_key from resolved_track
          join tracks on tracks.track_id = resolved_track.track_id
          limit 1`,
  });
  const row = typedRow<{ source_audio_key: string | null }>(result.rows);

  return row ? (row.source_audio_key ?? null) : null;
}

const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 50;

export async function searchTracks(options: {
  q: string;
  limit?: number;
}): Promise<TrackListItem[]> {
  const q = options.q.trim();

  if (!q) {
    return [];
  }

  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? SEARCH_DEFAULT_LIMIT) || SEARCH_DEFAULT_LIMIT, 1),
    SEARCH_MAX_LIMIT,
  );
  const needle = q.toLowerCase();

  const db = await getDb();
  const result = await db.execute({
    args: [needle, needle, needle, needle, limit],
    sql: `select ${TRACK_SELECT}
          from ${FINDINGS_FROM}
          where lower(tracks.track_id) like '%' || ? || '%'
             or lower(findings.log_id) like '%' || ? || '%'
             or lower(tracks.title) like '%' || ? || '%'
             or lower(tracks.artists_json) like '%' || ? || '%'
          order by findings.added_at desc, tracks.track_id desc
          limit ?`,
  });

  return typedRows<TrackRow>(result.rows).map(toTrackListItem);
}

export async function listRecentlyRenderedFindings(limit: number): Promise<BoardTrackListItem[]> {
  const db = await getDb();

  const result = await db.execute({
    args: [limit],
    sql: `select ${BOARD_TRACK_SELECT} from ${FINDINGS_FROM}
          where findings.video_url is not null
          order by findings.video_squared_at desc, findings.added_at desc, tracks.track_id desc
          limit ?`,
  });

  return typedRows<TrackRow>(result.rows).map(toBoardTrackListItem);
}

export async function hasTrackFeatures(trackId: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({
    args: [trackId],
    sql: `select 1 as present from tracks
          where track_id = ? and features_json is not null and trim(features_json) <> ''
          limit 1`,
  });

  return result.rows.length > 0;
}

export type CaptureSourceState = {
  captureSourcePin: null | string;

  captureSourcePinAllowDuration: boolean;
  captureStatus: string;
  captureVerification: null | string;
  hasCapturedAudio: boolean;
  sourceAudioFailures: number;
  youtubeVideoId: null | string;
};

export async function getCaptureSourceState(trackId: string): Promise<CaptureSourceState | null> {
  const db = await getDb();
  const result = await db.execute({
    args: [trackId],
    sql: `select capture_source_pin, capture_source_pin_allow_duration, capture_status,
                 capture_verification, (source_audio_key is not null) as has_captured_audio,
                 source_audio_failures, youtube_video_id
          from tracks
          where track_id = ? limit 1`,
  });
  const row = typedRow<{
    capture_source_pin: null | string;
    capture_source_pin_allow_duration: bigint | null | number;
    capture_status: string;
    capture_verification: null | string;
    has_captured_audio: bigint | number;
    source_audio_failures: bigint | null | number;
    youtube_video_id: null | string;
  }>(result.rows);

  if (!row) {
    return null;
  }

  return {
    captureSourcePin: row.capture_source_pin,
    captureSourcePinAllowDuration: Number(row.capture_source_pin_allow_duration ?? 0) === 1,
    captureStatus: row.capture_status,
    captureVerification: row.capture_verification,
    hasCapturedAudio: Number(row.has_captured_audio) === 1,
    sourceAudioFailures: Number(row.source_audio_failures ?? 0),
    youtubeVideoId: row.youtube_video_id,
  };
}

export async function getTracksForMixtape(mixtapeId: string): Promise<MixtapeMember[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [mixtapeId],
    sql: `select ${TRACK_SELECT}, mt.start_ms as start_ms
          from ${FINDINGS_FROM}
          join mixtape_tracks mt on mt.track_id = tracks.track_id and mt.mixtape_id = ?
          order by mt.position asc`,
  });

  return typedRows<TrackRow & { start_ms: number | null }>(result.rows).map((row) => ({
    ...toTrackListItem(row),
    startMs: row.start_ms ?? undefined,
  }));
}

export async function getRandomTrack(): Promise<TrackListItem | undefined> {
  const db = await getDb();
  const result = await db.execute({
    sql: `select ${TRACK_SELECT} from ${FINDINGS_FROM} order by random() limit 1`,
  });
  const row = typedRow<TrackRow>(result.rows);

  return row ? toTrackListItem(row) : undefined;
}

export async function getRandomRadioTrack(): Promise<TrackListItem | undefined> {
  const db = await getDb();
  const result = await db.execute({
    sql: `select ${TRACK_SELECT} from ${FINDINGS_FROM}
          where findings.video_squared_at is not null
            and findings.observation_audio_url is not null
          order by random() limit 1`,
  });
  const row = typedRow<TrackRow>(result.rows);

  return row ? toTrackListItem(row) : undefined;
}

export async function getRadioEligibleTracks(): Promise<RadioScheduleEntry[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: `select track_id, log_id, observation_duration_ms
          from findings
          where video_squared_at is not null
            and observation_audio_url is not null
            and observation_duration_ms is not null
            and log_id is not null
          order by added_at asc, track_id asc`,
  });

  return typedRows<{
    log_id: string;
    observation_duration_ms: number;
    track_id: string;
  }>(result.rows).map((row) => ({
    logId: row.log_id,
    observationDurationMs: row.observation_duration_ms,
    trackId: row.track_id,
  }));
}

export async function getRadioScheduleFingerprint(): Promise<string> {
  const db = await getDb();
  const result = await db.execute({
    sql: `select count(*) as count,
                 coalesce(max(observation_generated_at), '') as latest
          from findings
          where video_squared_at is not null
            and observation_audio_url is not null
            and observation_duration_ms is not null
            and log_id is not null`,
  });
  const row = typedRow<{ count: number; latest: string }>(result.rows);

  return `${Number(row?.count ?? 0)}:${row?.latest ?? ""}`;
}

type RadioScheduleRow = {
  epoch_ms: number;
  version: string;
};

export async function getRadioScheduleAnchor(
  version: string,
  oldLoopDurationMs: number,
  nowMs: number = Date.now(),
): Promise<{ epochMs: number; version: string }> {
  const db = await getDb();
  const stored = typedRow<RadioScheduleRow>(
    (
      await db.execute({
        args: ["radio"],
        sql: `select epoch_ms, version from radio_schedule where service = ?`,
      })
    ).rows,
  );

  if (stored && stored.version === version) {
    return { epochMs: stored.epoch_ms, version };
  }

  const epochMs = stored ? nextBoundaryEpochMs(stored.epoch_ms, oldLoopDurationMs, nowMs) : nowMs;
  const generatedAt = new Date(nowMs).toISOString();

  await db.execute({
    args: [epochMs, generatedAt, version],
    sql: `insert into radio_schedule (service, epoch_ms, generated_at, version)
          values ('radio', ?, ?, ?)
          on conflict(service) do update set
            epoch_ms = excluded.epoch_ms,
            generated_at = excluded.generated_at,
            version = excluded.version`,
  });

  return { epochMs, version };
}

export type TrackNeighbor = {
  artists: string[];
  logId: string;
  title: string;
};

type NeighborRow = {
  artists_json: string;
  log_id: string;
  title: string;
};

export async function getTrackNeighbors(track: {
  addedAt: string;
  trackId: string;
}): Promise<{ newer?: TrackNeighbor; older?: TrackNeighbor }> {
  const db = await getDb();
  const select = `select findings.log_id, tracks.title, tracks.artists_json
    from ${FINDINGS_FROM} where findings.log_id is not null`;
  const [newerResult, olderResult] = await Promise.all([
    db.execute({
      args: [track.addedAt, track.addedAt, track.trackId],
      sql: `${select} and (findings.added_at > ? or (findings.added_at = ? and tracks.track_id > ?))
            order by findings.added_at asc, tracks.track_id asc limit 1`,
    }),
    db.execute({
      args: [track.addedAt, track.addedAt, track.trackId],
      sql: `${select} and (findings.added_at < ? or (findings.added_at = ? and tracks.track_id < ?))
            order by findings.added_at desc, tracks.track_id desc limit 1`,
    }),
  ]);
  const toNeighbor = (row: NeighborRow | undefined): TrackNeighbor | undefined =>
    row
      ? { artists: parseArtistsJson(row.artists_json), logId: row.log_id, title: row.title }
      : undefined;

  return {
    newer: toNeighbor(typedRow<NeighborRow>(newerResult.rows)),
    older: toNeighbor(typedRow<NeighborRow>(olderResult.rows)),
  };
}

export async function getSimilarFindings(
  idOrLogId: string,
  limit = 6,
  options: { allowBoundedSql?: boolean } = {},
): Promise<TrackListItem[]> {
  if (limit <= 0) {
    return [];
  }

  const sonarEnabled = await isSonarLogEnabled();

  if (!sonarEnabled && options.allowBoundedSql !== true) {
    return [];
  }

  const db = await getDb();
  const targetResult = await db.execute({
    args: [idOrLogId, idOrLogId, idOrLogId],
    sql: `with ${FINDING_TRACK_OR_LOG_ID_CTE}
          select emb.embedding_blob,
                 tracks.track_id
          from resolved_track
          join findings on findings.track_id = resolved_track.track_id
          join tracks on tracks.track_id = resolved_track.track_id
          left join track_embeddings emb on emb.track_id = tracks.track_id
          limit 1`,
  });
  const targetRow = typedRow<{ embedding_blob: unknown; track_id: string }>(targetResult.rows);

  if (!targetRow) {
    return [];
  }

  const target = readEmbeddingBlob(targetRow.embedding_blob);

  if (!target) {
    return [];
  }

  if (sonarEnabled) {
    const matches = await searchSonar({
      excludeIds: [targetRow.track_id],
      filter: { certified: true },
      index: "tracks",
      probes: [target],
      topK: limit,
    });

    return matches === null ? [] : hydrateSimilarFindings(matches);
  }

  const probe = toVectorProbe(target);

  const rankedResult = await executeVectorFallback(db, "sonar.fallback.log", {
    args: [targetRow.track_id, probe, limit],
    sql: `with candidates(track_id) as materialized (
              select tracks.track_id
              from ${FINDINGS_FROM}
              join track_embeddings emb on emb.track_id = tracks.track_id
              where findings.log_id is not null
                and tracks.track_id != ?
              order by tracks.track_id
              ${vectorFallbackCandidateLimitSql()}
            ), winners(track_id, dist) as materialized (
            select candidates.track_id, vector_distance_cos(emb.embedding_blob, ?) as dist
            from candidates
            join track_embeddings emb on emb.track_id = candidates.track_id
            order by dist asc, candidates.track_id asc
            limit ?
          )
          select ${TRACK_SELECT}
          from winners
          cross join tracks on tracks.track_id = winners.track_id
          cross join findings on findings.track_id = tracks.track_id
          order by winners.dist asc, winners.track_id asc`,
  });

  return typedRows<TrackRow>(rankedResult.rows).map((row) => toTrackListItem(row));
}

async function hydrateSimilarFindings(matches: SonarMatch[]): Promise<TrackListItem[]> {
  return hydrateRankedSonarMatches(
    matches,
    async (ids) => {
      const placeholders = ids.map(() => "?").join(", ");
      const db = await getDb();
      const result = await db.execute({
        args: ids,
        sql: `select ${TRACK_SELECT} from ${FINDINGS_FROM}
              where tracks.track_id in (${placeholders}) and findings.log_id is not null`,
      });

      return typedRows<TrackRow>(result.rows);
    },
    (row) => row.track_id,
    (row) => toTrackListItem(row),
  );
}

const MIX_FROM = `tracks left join findings on findings.track_id = tracks.track_id`;

const MIX_TRACK_SELECT = `tracks.track_id, tracks.title, tracks.artists_json, tracks.album_image_url,
  tracks.spotify_url, tracks.apple_music_url, tracks.duration_ms, tracks.bpm, tracks.key, findings.log_id`;

type MixTrackRow = {
  album_image_url: string | null;

  apple_music_url: string | null;
  artists_json: string;
  bpm: number | null;
  duration_ms: number;
  key: string | null;
  log_id: string | null;

  spotify_url: string | null;
  title: string;
  track_id: string;
};

function toMixTrackDTO(row: MixTrackRow): MixTrackDTO {
  return {
    albumImageUrl: row.album_image_url ?? undefined,
    appleMusicUrl: row.apple_music_url ?? undefined,
    artists: parseArtistsJson(row.artists_json),
    bpm: row.bpm ?? undefined,
    certified: Boolean(row.log_id),
    durationMs: row.duration_ms,
    key: row.key ?? undefined,
    logId: row.log_id ?? undefined,
    spotifyUrl: row.spotify_url ?? undefined,
    title: row.title,
    trackId: row.track_id,
  };
}

type MixRow = {
  bpm: number | null;
  embedding_blob: unknown;
  features_json: string | null;
  key: string | null;
  log_id: string | null;
  track_id: string;
};

type MixCandidateRow = Omit<MixRow, "embedding_blob"> & {
  has_embedding: number | null;
  sonic_dist: number | null;
};

export async function getMixChainDepth(): Promise<MixChainDepth> {
  return mixChainDepth(await readKeyHistogram());
}

async function namedMoveKeys(from: Camelot): Promise<string[]> {
  const histogram = await readKeyHistogram();
  const wanted = new Set(namedMoveClasses(from).map(({ letter, number }) => `${number}${letter}`));

  return histogram.flatMap((row) => {
    const code = keyToCamelotCode(row.key);

    return row.key && code && wanted.has(code) ? [row.key] : [];
  });
}

function camelotOfKey(key: string | null): Camelot | null {
  const parsed = parseKey(key);

  return parsed ? toCamelot(parsed) : null;
}

function rankMixRail(
  target: RankTrack,
  candidates: RankCandidate<string>[],
  limit: number,
  options: { gateOpen: boolean; tasteLive: boolean },
): { item: string; reason: MixReason }[] {
  if (!options.tasteLive) {
    return rankMixable(target, candidates, limit, { gateOpen: options.gateOpen });
  }

  const cosByTrackId = new Map(
    candidates.flatMap((candidate) =>
      typeof candidate.sonicCos === "number" ? [[candidate.item, candidate.sonicCos] as const] : [],
    ),
  );
  const shortlist = shortlistMixable(target, candidates, TASTE_SHORTLIST, {
    gateOpen: options.gateOpen,
  });

  return applyTaste(
    shortlist,
    (trackId) => tasteSubScore(cosByTrackId.get(trackId) ?? null),
    limit,
  );
}

export async function getMixableTracks(
  idOrLogId: string,
  options: { exclude?: string[]; limit?: number } = {},
): Promise<MixCandidateDTO[]> {
  try {
    return await raceWithDeadline(mixRail(idOrLogId, options), MIX_RAIL_DEADLINE_MS, "mix.rail");
  } catch (error) {
    if (!isVectorDeadlineExpired(error)) {
      throw error;
    }

    console.warn(`${error.label} exceeded ${error.deadlineMs}ms — serving an empty rail`);

    return [];
  }
}

async function mixRail(
  idOrLogId: string,
  options: { exclude?: string[]; limit?: number },
): Promise<MixCandidateDTO[]> {
  const limit = options.limit ?? RAIL_DEPTH;

  if (limit <= 0) {
    return [];
  }

  const db = await getDb();

  const warmingKeyHistogram = readKeyHistogram();

  warmingKeyHistogram.catch(() => undefined);

  const targetResult = await db.execute({
    args: [idOrLogId, idOrLogId, idOrLogId],
    sql: `with ${TRACK_OR_LOG_ID_CTE}
          select tracks.track_id, findings.log_id, tracks.key, tracks.bpm,
                 emb.embedding_blob, tracks.features_json
          from resolved_track
          join tracks on tracks.track_id = resolved_track.track_id
          left join findings on findings.track_id = tracks.track_id
          left join track_embeddings emb on emb.track_id = tracks.track_id
          where ${publicTrackDurationWhere("tracks", "findings")}
          limit 1`,
  });
  const targetRow = typedRow<MixRow>(targetResult.rows);

  if (!targetRow) {
    return [];
  }

  const targetCamelot = camelotOfKey(targetRow.key);

  if (!targetCamelot) {
    return [];
  }

  const sonarMixEnabled = targetRow.embedding_blob === null ? null : isSonarMixEnabled();

  sonarMixEnabled?.catch(() => undefined);

  const keys = await namedMoveKeys(targetCamelot);

  if (keys.length === 0) {
    return [];
  }

  const targetEmbedding = readEmbeddingBlob(targetRow.embedding_blob);
  const probe = targetEmbedding ? toVectorProbe(targetEmbedding) : null;

  const excluded = [...new Set((options.exclude ?? []).map((id) => id.trim()).filter(Boolean))];
  const excludedLogIds = excluded.filter((id) => isLogId(id));
  const excludedTrackIds = excluded.filter((id) => !isLogId(id));

  const target = toMixTrack(targetRow);

  if (targetEmbedding && (await sonarMixEnabled)) {
    const railed = await mixRailFromSonar({
      excludedLogIds,
      excludedTrackIds,
      keys,
      limit,
      target,
      targetEmbedding,
      targetTrackId: targetRow.track_id,
    });

    if (railed) {
      return railed;
    }
  }

  const keyClause = keys.map(() => "?").join(", ");
  const logIdClause =
    excludedLogIds.length > 0
      ? `and (findings.log_id is null or findings.log_id not in (${excludedLogIds.map(() => "?").join(", ")}))`
      : "";
  const trackIdClause =
    excludedTrackIds.length > 0
      ? `and tracks.track_id not in (${excludedTrackIds.map(() => "?").join(", ")})`
      : "";

  const candidateFrom = excludedLogIds.length > 0 ? MIX_FROM : `tracks`;
  const distanceSql = probe ? `vector_distance_cos(emb.embedding_blob, ?)` : `null`;
  const candidateStatement = {
    args: [
      ...keys,
      targetRow.track_id,
      ...excludedLogIds,
      ...excludedTrackIds,
      ...(probe ? [probe] : []),
    ],

    sql: `with candidates(track_id) as materialized (
            select tracks.track_id
            from ${candidateFrom}
            where tracks.key in (${keyClause})
              and ${publicTrackDurationWhere("tracks")}
              and tracks.track_id != ? ${logIdClause} ${trackIdClause}
            order by tracks.rowid
            ${vectorFallbackCandidateLimitSql()}
          )
          select tracks.track_id as track_id, findings.log_id as log_id, tracks.key as key,
                 tracks.bpm as bpm, tracks.features_json as features_json,
                 tracks.has_embedding as has_embedding,
                 case when emb.embedding_blob is null then null else ${distanceSql} end as sonic_dist
          from candidates
          join tracks on tracks.track_id = candidates.track_id
          left join findings on findings.track_id = tracks.track_id
          left join track_embeddings emb on emb.track_id = tracks.track_id
          order by tracks.rowid`,
  };

  const candidateResult = await executeVectorFallback(
    db,
    "sonar.fallback.mix",
    candidateStatement,
    {
      deadlineMs: MIX_RAIL_SCAN_DEADLINE_MS,
    },
  );

  const candidateRows = typedRows<MixCandidateRow>(candidateResult.rows);
  const candidates: RankCandidate<string>[] = candidateRows.map((row) => ({
    item: row.track_id,

    sonicCos: probe ? cosineFromDistance(row.sonic_dist) : null,
    track: toMixTrack({ ...row, embedding_blob: null }),
  }));

  const embeddedCount =
    candidateRows.filter((row) => Boolean(row.has_embedding)).length +
    (targetRow.embedding_blob !== null ? 1 : 0);
  const gateOpen = sonicGateOpen(embeddedCount);

  const ranked = rankMixRail(target, candidates, limit, {
    gateOpen,
    tasteLive: probe !== null && gateOpen,
  });

  return hydrateMixRail(ranked);
}

async function mixRailFromSonar(params: {
  excludedLogIds: string[];
  excludedTrackIds: string[];
  keys: string[];
  limit: number;
  target: RankTrack;
  targetEmbedding: number[];
  targetTrackId: string;
}): Promise<MixCandidateDTO[] | null> {
  const excludeIds = [
    params.targetTrackId,
    ...params.excludedTrackIds,
    ...(await resolveTrackIdsByLogIds(params.excludedLogIds)),
  ];
  const matches = await searchSonar({
    excludeIds,
    filter: { key_in: params.keys },
    index: "tracks",
    probes: [params.targetEmbedding],
    topK: TASTE_SHORTLIST,
  });

  if (!matches || matches.length === 0) {
    return null;
  }

  const ids = [...new Set(matches.map((match) => match.id))];
  const rowById = new Map((await getMixScoringRows(ids)).map((row) => [row.track_id, row]));

  const candidates: RankCandidate<string>[] = matches.flatMap((match) => {
    const row = rowById.get(match.id);

    return row
      ? [
          {
            item: row.track_id,

            sonicCos: match.score,
            track: toMixTrack({ ...row, embedding_blob: null }),
          },
        ]
      : [];
  });

  const gateOpen = sonicGateOpen(matches.length + 1);
  const ranked = rankMixRail(params.target, candidates, params.limit, {
    gateOpen,
    tasteLive: gateOpen,
  });

  return ranked.length === 0 ? null : hydrateMixRail(ranked);
}

async function resolveTrackIdsByLogIds(logIds: string[]): Promise<string[]> {
  if (logIds.length === 0) {
    return [];
  }

  const db = await getDb();
  const result = await db.execute({
    args: logIds,
    sql: `select tracks.track_id from ${MIX_FROM}
          where findings.log_id in (${logIds.map(() => "?").join(", ")})`,
  });

  return typedRows<{ track_id: string }>(result.rows).map((row) => row.track_id);
}

async function getMixScoringRows(trackIds: string[]): Promise<Omit<MixRow, "embedding_blob">[]> {
  if (trackIds.length === 0) {
    return [];
  }

  const db = await getDb();
  const result = await db.execute({
    args: trackIds,
    sql: `select tracks.track_id, findings.log_id, tracks.key, tracks.bpm, tracks.features_json
          from ${MIX_FROM}
          where tracks.track_id in (${trackIds.map(() => "?").join(", ")})
            and ${publicTrackDurationWhere("tracks", "findings")}`,
  });

  return typedRows<Omit<MixRow, "embedding_blob">>(result.rows);
}

async function hydrateMixRail(
  ranked: { item: string; reason: MixReason }[],
): Promise<MixCandidateDTO[]> {
  if (ranked.length === 0) {
    return [];
  }

  const byId = await getMixTracksByIds(ranked.map((entry) => entry.item));

  return ranked.flatMap((entry) => {
    const item = byId[entry.item];

    return item ? [{ ...item, reason: entry.reason }] : [];
  });
}

async function getMixTracksByIds(trackIds: string[]): Promise<Record<string, MixTrackDTO>> {
  const unique = [...new Set(trackIds.filter((id) => id.trim()))];

  if (unique.length === 0) {
    return {};
  }

  const db = await getDb();
  const result = await db.execute({
    args: unique,
    sql: `select ${MIX_TRACK_SELECT} from ${MIX_FROM}
          where tracks.track_id in (${unique.map(() => "?").join(", ")})
            and ${publicTrackDurationWhere("tracks", "findings")}`,
  });

  const byTrackId: Record<string, MixTrackDTO> = {};

  for (const row of typedRows<MixTrackRow>(result.rows)) {
    byTrackId[row.track_id] = toMixTrackDTO(row);
  }

  return byTrackId;
}

export async function getMixTracksByTokens(tokens: string[]): Promise<MixTrackDTO[]> {
  const unique = [...new Set(tokens.map((token) => token.trim()).filter(Boolean))];

  if (unique.length === 0) {
    return [];
  }

  const logIds = unique.filter((token) => isLogId(token));
  const trackIds = unique.filter((token) => !isLogId(token));
  const clauses: string[] = [];

  if (logIds.length > 0) {
    clauses.push(`findings.log_id in (${logIds.map(() => "?").join(", ")})`);
  }
  if (trackIds.length > 0) {
    clauses.push(`tracks.track_id in (${trackIds.map(() => "?").join(", ")})`);
  }

  const db = await getDb();
  const result = await db.execute({
    args: [...logIds, ...trackIds],
    sql: `select ${MIX_TRACK_SELECT} from ${MIX_FROM}
          where (${clauses.join(" or ")}) and ${publicTrackDurationWhere("tracks", "findings")}`,
  });

  const byToken = new Map<string, MixTrackDTO>();

  for (const row of typedRows<MixTrackRow>(result.rows)) {
    const item = toMixTrackDTO(row);

    byToken.set(row.track_id, item);

    if (row.log_id) {
      byToken.set(row.log_id, item);
    }
  }

  return unique.flatMap((token) => {
    const item = byToken.get(token);

    return item ? [item] : [];
  });
}

export async function listMixableArtists(
  options: { limit?: number; q?: string } = {},
): Promise<MixArtist[]> {
  const limit = Math.min(Math.max(options.limit ?? 60, 1), 200);
  const q = options.q?.trim() ?? "";
  const db = await getDb();

  return readMixableArtistsProjection(db, { limit, q });
}

export async function getMixOpeners(
  artistSlugs: string[],
  options: { limit?: number } = {},
): Promise<MixTrackDTO[]> {
  const slugs = [...new Set(artistSlugs.map((slug) => slug.trim()).filter(Boolean))];
  const limit = Math.min(Math.max(options.limit ?? 24, 1), 60);

  if (slugs.length === 0) {
    return [];
  }

  const db = await getDb();
  const result = await db.execute({
    args: [...slugs, limit],
    sql: `select distinct ${MIX_TRACK_SELECT}
          from ${MIX_FROM}
          join track_artists on track_artists.track_id = tracks.track_id
          join artists on artists.id = track_artists.artist_id
          where artists.slug in (${slugs.map(() => "?").join(", ")})
            and tracks.key is not null
            and tracks.has_embedding = 1
          order by (findings.log_id is not null) desc, tracks.popularity desc
          limit ?`,
  });

  return typedRows<MixTrackRow>(result.rows).map(toMixTrackDTO);
}

export type MixOrderStop = {
  artists: string[];
  bpm?: number;
  flagged: boolean;
  key?: string;
  logId: string;
  title: string;
  transitionReason?: MixReason;
  transitionScore?: number;
};

export type MixableOrderResult = {
  algorithm: "held-karp" | "greedy-2opt";
  order: MixOrderStop[];
  totalCost: number;
};

export async function getMixableOrder(
  logIds: string[],
  options: { seedLogId?: string } = {},
): Promise<MixableOrderResult> {
  const unique = [...new Set(logIds.filter((id) => id.trim()))];

  const db = await getDb();
  const placeholders = unique.map(() => "?").join(", ");
  const result = await db.execute({
    args: unique,

    sql: `select tracks.track_id, findings.log_id, tracks.key, tracks.bpm,
                 emb.embedding_blob, tracks.features_json, tracks.title, tracks.artists_json
          from ${FINDINGS_FROM}
          left join track_embeddings emb on emb.track_id = tracks.track_id
          where findings.log_id in (${placeholders})`,
  });

  const rowByLogId = new Map<string, MixRow & { artists_json: string; title: string }>();

  for (const row of typedRows<MixRow & { artists_json: string; title: string }>(result.rows)) {
    if (row.log_id) {
      rowByLogId.set(row.log_id, row);
    }
  }

  const missing = unique.filter((id) => !rowByLogId.has(id));

  if (missing.length > 0) {
    throw new MixableOrderError(`No finding for ${missing.join(", ")}`);
  }

  const ordered = unique.map((id) => {
    const row = rowByLogId.get(id);

    if (!row) {
      throw new MixableOrderError(`No finding for ${id}`);
    }

    return row;
  });

  const tracks = ordered.map((row) => toMixTrack(row));
  const embeddedCount = ordered.filter((row) => row.embedding_blob !== null).length;
  const gateOpen = sonicGateOpen(embeddedCount);

  const seedIndex = options.seedLogId !== undefined ? unique.indexOf(options.seedLogId) : -1;

  const path = orderMixPath(tracks, {
    gateOpen,
    seedIndex: seedIndex >= 0 ? seedIndex : undefined,
  });

  const order: MixOrderStop[] = path.order.map((trackIndex, position) => {
    const row = ordered[trackIndex];
    const from = position > 0 ? tracks[path.order[position - 1] ?? -1] : undefined;
    const to = tracks[trackIndex];
    const edge = from && to ? scoreMix(from, to, { gateOpen }) : undefined;

    return {
      artists: row ? parseArtistsJson(row.artists_json) : [],
      bpm: row?.bpm ?? undefined,
      flagged: position > 0 ? (edge?.score ?? null) === null : false,
      key: row?.key ?? undefined,
      logId: row?.log_id ?? "",
      title: row?.title ?? "",
      transitionReason: edge?.reason ?? undefined,
      transitionScore: edge?.score ?? undefined,
    };
  });

  return { algorithm: path.algorithm, order, totalCost: path.totalCost };
}

export class MixableOrderError extends Error {}

export async function getFindingsByGalaxyRanked(
  galaxyId: string,
  centroid: number[],
  limit: number,
  offset: number,
): Promise<TrackListItem[]> {
  const pageIds = await rankGalaxyMemberIds(galaxyId, centroid, limit, offset);

  if (pageIds.length === 0) {
    return [];
  }

  const byId = await getTracksByIds(pageIds);

  return pageIds.flatMap((id) => {
    const item = byId[id];
    return item ? [item] : [];
  });
}

export async function getGalaxyAuditionMembers(
  galaxyId: string,
  centroid: number[],
  limit: number,
  offset: number,
): Promise<BoardTrackListItem[]> {
  const pageIds = await rankGalaxyMemberIds(galaxyId, centroid, limit, offset);

  if (pageIds.length === 0) {
    return [];
  }

  const byId = await getBoardTracksByIds(pageIds);

  return pageIds.flatMap((id) => {
    const item = byId[id];
    return item ? [item] : [];
  });
}

async function rankGalaxyMemberIds(
  galaxyId: string,
  centroid: number[],
  limit: number,
  offset: number,
): Promise<string[]> {
  if (limit <= 0) {
    return [];
  }

  const db = await getDb();

  const probe = toVectorProbe(centroid);
  const pageResult = await db.execute({
    args: [galaxyId, probe, limit, offset],
    sql: `select track_id from (
            select emb.embedding_blob as vec,
                   tracks.track_id as track_id
            from ${FINDINGS_FROM}
            left join track_embeddings emb on emb.track_id = tracks.track_id
            where findings.galaxy_id = ? and findings.log_id is not null
          )
          order by (vec is null) asc,
                   case when vec is not null then vector_distance_cos(vec, ?) end asc,
                   track_id asc
          limit ? offset ?`,
  });

  return typedRows<{ track_id: string }>(pageResult.rows).map((row) => row.track_id);
}

export async function listEmbeddingPresenceForTracks(trackIds: string[]): Promise<Set<string>> {
  if (trackIds.length === 0) {
    return new Set();
  }

  const db = await getDb();
  const placeholders = trackIds.map(() => "?").join(", ");
  const result = await db.execute({
    args: trackIds,
    sql: `select track_id from track_embeddings
          where track_id in (${placeholders})`,
  });

  return new Set(typedRows<{ track_id: string }>(result.rows).map((row) => row.track_id));
}

type TrackCountRow = {
  total_count: number;
};

export const ENRICH_STALE_PROCESSING_MS = 30 * 60 * 1000;

export const CAPTURE_FAILED_COOLDOWN_MS = 60 * 60 * 1000;
export const CAPTURE_MAX_FAILURES = 8;

export type EnrichmentStatusFilter = "pending" | "processing" | "done" | "failed" | "queue";

export const ENRICHMENT_STATUS_FILTERS: readonly EnrichmentStatusFilter[] = [
  "pending",
  "processing",
  "done",
  "failed",
  "queue",
];

type FindingDueWorkKind =
  | "finding.context"
  | "finding.context.retry-empty"
  | "finding.enrich"
  | "finding.note"
  | "finding.observe"
  | "finding.render"
  | "finding.render.requires-observation";

type ListTracksOptions = {
  board?: boolean;

  captureQueue?: boolean;

  countTotal?: boolean;
  cursor?: TrackCursor;

  hasContext?: boolean;

  hasEmbedding?: boolean;

  hasObservation?: boolean;

  hasNote?: boolean;

  hasKey?: boolean;

  hasVideo?: boolean;
  includeMixtapes?: boolean;

  lean?: boolean;
  limit: number;

  order?: "asc" | "desc";

  retryEmptyContext?: boolean;

  releaseThrough?: string;
  since?: string;

  status?: EnrichmentStatusFilter;
  until?: string;
};

export function groupArtistYoutubeChannelIds(
  rows: { track_id: string; url: string }[],
): Map<string, string[]> {
  const byTrack = new Map<string, string[]>();

  for (const row of rows) {
    const channelId = extractYoutubeChannelId(row.url);

    if (!channelId) {
      continue;
    }

    const existing = byTrack.get(row.track_id);

    if (!existing) {
      byTrack.set(row.track_id, [channelId]);
    } else if (!existing.includes(channelId)) {
      existing.push(channelId);
    }
  }

  return byTrack;
}

export async function readArtistYoutubeChannelIdsByTrack(
  db: Awaited<ReturnType<typeof getDb>>,
  trackIds: readonly string[],
): Promise<Map<string, string[]>> {
  if (trackIds.length === 0) {
    return new Map();
  }

  const placeholders = trackIds.map(() => "?").join(", ");
  const result = await db.execute({
    args: [...trackIds],
    sql: `select track_artists.track_id as track_id, artist_socials.url as url
          from artist_socials
          join track_artists on track_artists.artist_id = artist_socials.artist_id
          where artist_socials.platform = 'youtube'
            and track_artists.track_id in (${placeholders})`,
  });

  return groupArtistYoutubeChannelIds(typedRows<{ track_id: string; url: string }>(result.rows));
}

async function attachArtistYoutubeChannelIds(
  db: Awaited<ReturnType<typeof getDb>>,
  items: TrackListItem[],
): Promise<void> {
  const byTrack = await readArtistYoutubeChannelIdsByTrack(
    db,
    items.map((item) => item.trackId),
  );

  for (const item of items) {
    const channelIds = byTrack.get(item.trackId);

    if (channelIds && channelIds.length > 0) {
      item.artistYoutubeChannelIds = channelIds;
    }
  }
}

type FindingDueWorkSelector = Pick<
  ListTracksOptions,
  | "captureQueue"
  | "hasContext"
  | "hasEmbedding"
  | "hasKey"
  | "hasNote"
  | "hasObservation"
  | "hasVideo"
  | "includeMixtapes"
  | "order"
  | "retryEmptyContext"
  | "releaseThrough"
  | "since"
  | "status"
  | "until"
>;

function isUnsupportedFindingDueWorkShape(options: FindingDueWorkSelector): boolean {
  return (
    options.order !== "asc" ||
    options.captureQueue ||
    options.includeMixtapes ||
    options.releaseThrough !== undefined ||
    options.since !== undefined ||
    options.until !== undefined ||
    options.hasEmbedding !== undefined ||
    options.hasKey !== undefined
  );
}

function selectFindingDueWorkKind(options: FindingDueWorkSelector): FindingDueWorkKind | undefined {
  if (isUnsupportedFindingDueWorkShape(options)) {
    return undefined;
  }

  const { hasContext, hasNote, hasObservation, hasVideo, retryEmptyContext, status } = options;

  if (
    status === "queue" &&
    hasContext === undefined &&
    hasNote === undefined &&
    hasObservation === undefined &&
    hasVideo === undefined
  ) {
    return "finding.enrich";
  }

  if (
    status === undefined &&
    hasContext === false &&
    hasNote === undefined &&
    hasObservation === undefined &&
    hasVideo === undefined
  ) {
    return retryEmptyContext ? "finding.context.retry-empty" : "finding.context";
  }

  if (
    status === undefined &&
    hasContext === true &&
    hasNote === false &&
    hasObservation === undefined &&
    hasVideo === undefined
  ) {
    return "finding.note";
  }

  if (
    status === undefined &&
    hasContext === true &&
    hasNote === undefined &&
    hasObservation === false &&
    hasVideo === undefined
  ) {
    return "finding.observe";
  }

  if (
    status === undefined &&
    hasContext === true &&
    hasNote === undefined &&
    (hasObservation === undefined || hasObservation === true) &&
    hasVideo === false
  ) {
    return hasObservation === true ? "finding.render.requires-observation" : "finding.render";
  }

  return undefined;
}

type TrackListFilters = Pick<
  ListTracksOptions,
  | "captureQueue"
  | "hasContext"
  | "hasEmbedding"
  | "hasKey"
  | "hasNote"
  | "hasObservation"
  | "hasVideo"
  | "releaseThrough"
  | "retryEmptyContext"
  | "since"
  | "status"
  | "until"
>;

function buildTrackListFilters({
  captureQueue,
  hasContext,
  hasEmbedding,
  hasKey,
  hasNote,
  hasObservation,
  hasVideo,
  retryEmptyContext = false,
  releaseThrough,
  since,
  status,
  until,
}: TrackListFilters): { filterArgs: string[]; filterClauses: string[] } {
  const filterClauses: string[] = [];
  const filterArgs: string[] = [];

  if (releaseThrough) {
    filterClauses.push(releasedByTodaySql("tracks.release_date"));
    filterArgs.push(releaseThrough);
  }

  if (since) {
    filterClauses.push("findings.added_at >= ?");
    filterArgs.push(since);
  }
  if (until) {
    filterClauses.push("findings.added_at < ?");
    filterArgs.push(until);
  }

  if (hasVideo !== undefined) {
    filterClauses.push(`findings.video_url is ${hasVideo ? "not " : ""}null`);
  }

  if (hasKey !== undefined) {
    filterClauses.push(`tracks.key is ${hasKey ? "not " : ""}null`);
  }

  if (hasEmbedding === true) {
    filterClauses.push("tracks.has_embedding = 1");
  } else if (hasEmbedding === false) {
    filterClauses.push("tracks.has_embedding = 0 and tracks.source_audio_key is not null");
  }

  if (hasContext === true) {
    filterClauses.push("findings.context_note is not null");
  } else if (hasContext === false) {
    filterClauses.push(
      retryEmptyContext
        ? "(findings.context_note is null and (findings.context_status is null or findings.context_status in ('pending', 'failed', 'empty')))"
        : "(findings.context_note is null and (findings.context_status is null or findings.context_status in ('pending', 'failed')))",
    );
  }

  if (hasObservation !== undefined) {
    filterClauses.push(`findings.observation_audio_url is ${hasObservation ? "not " : ""}null`);
  }

  if (hasNote === true) {
    filterClauses.push("(findings.note is not null and trim(findings.note) != '')");
  } else if (hasNote === false) {
    filterClauses.push("(findings.note is null or trim(findings.note) = '')");
  }

  if (captureQueue) {
    const captureCooldown = new Date(Date.now() - CAPTURE_FAILED_COOLDOWN_MS).toISOString();
    filterClauses.push(
      `(findings.log_id is not null and (tracks.capture_status is null or tracks.capture_status = 'pending' or (tracks.capture_status = 'failed' and tracks.source_audio_failures < ${CAPTURE_MAX_FAILURES} and (tracks.source_audio_attempted_at is null or tracks.source_audio_attempted_at < ?))))`,
    );
    filterArgs.push(captureCooldown);
  }
  if (status === "queue") {
    const staleCutoff = new Date(Date.now() - ENRICH_STALE_PROCESSING_MS).toISOString();
    filterClauses.push(
      "(findings.enrichment_status in ('pending', 'failed') or (findings.enrichment_status = 'processing' and (findings.updated_at is null or findings.updated_at < ?)))",
    );
    filterArgs.push(staleCutoff);
  } else if (status) {
    filterClauses.push("findings.enrichment_status = ?");
    filterArgs.push(status);
  }

  return { filterArgs, filterClauses };
}

const EMPTY_RENDER_PAGE_IS_SERVABLE = new Set<FindingDueWorkKind>([
  "finding.render",
  "finding.render.requires-observation",
]);

async function listProjectedTracks(
  db: Awaited<ReturnType<typeof getDb>>,
  kind: FindingDueWorkKind,
  options: {
    countTotal: boolean;
    cursor: TrackCursor | undefined;
    limit: number;
    mapRow: (row: TrackRow) => TrackListItem;
    trackSelect: string;
  },
): Promise<TrackListPage | undefined> {
  if (!(await isDueWorkCutoverEnabled())) {
    return undefined;
  }

  const continuation = options.cursor
    ? {
        sortKey: encodeDueWorkOrder([
          { direction: "asc", kind: "timestamp", nulls: "first", value: options.cursor.addedAt },
          { direction: "asc", kind: "text", value: options.cursor.trackId },
        ]),
        subjectId: options.cursor.trackId,
      }
    : undefined;
  const page = await readPromotedDueWorkPage(db, kind, {
    continuation,
    emptyPageUnderDebt: EMPTY_RENDER_PAGE_IS_SERVABLE.has(kind) ? "serve" : "defer",
    limit: options.limit,
  });

  if (page.subjectIds.length === 0) {
    return { nextCursor: undefined, totalCount: 0, tracks: [] };
  }

  const placeholders = page.subjectIds.map(() => "?").join(", ");
  const result = await db.execute({
    args: page.subjectIds,
    sql: `select ${options.trackSelect}
          from ${FINDINGS_FROM}
          where tracks.track_id in (${placeholders})`,
  });
  const hydratedById = new Map(
    typedRows<TrackRow>(result.rows).map((row) => [row.track_id, row] as const),
  );
  const hydratedRows = page.subjectIds.flatMap((subjectId) => {
    const row = hydratedById.get(subjectId);
    return row ? [row] : [];
  });
  const lastVisibleRow = hydratedRows.at(-1);

  return {
    nextCursor:
      page.hasMore && lastVisibleRow
        ? encodeTrackCursor({
            addedAt: lastVisibleRow.added_at,
            trackId: lastVisibleRow.track_id,
          })
        : undefined,
    totalCount: options.countTotal ? await countDueWorkNow(db, kind) : hydratedRows.length,
    tracks: hydratedRows.map(options.mapRow),
  };
}

function trackListProjection(
  board: boolean,
  lean: boolean,
): {
  mapRow: (row: TrackRow) => TrackListItem;
  trackSelect: string;
} {
  if (board) {
    return { mapRow: toBoardTrackListItem, trackSelect: BOARD_TRACK_SELECT };
  }
  if (lean) {
    return { mapRow: toLeanTrackListItem, trackSelect: LEAN_TRACK_SELECT };
  }
  return { mapRow: toTrackListItem, trackSelect: TRACK_SELECT };
}

function includesPublishedMixtapeFeed(options: {
  hasVideo: boolean | undefined;
  includeMixtapes: boolean;
  since: string | undefined;
  status: string | undefined;
  until: string | undefined;
}): boolean {
  return (
    options.includeMixtapes &&
    !options.since &&
    !options.until &&
    options.hasVideo === undefined &&
    options.status === undefined
  );
}

export function listTracks(
  options: ListTracksOptions & { includeMixtapes: true },
): Promise<FeedListPage>;
export function listTracks(
  options: ListTracksOptions & { board: true },
): Promise<BoardTrackListPage>;
export function listTracks(options: ListTracksOptions): Promise<TrackListPage>;

export async function listTracks({
  board = false,
  captureQueue,
  countTotal = true,
  cursor,
  hasContext,
  hasEmbedding,
  hasKey,
  hasNote,
  hasObservation,
  hasVideo,
  includeMixtapes = false,
  lean = false,
  limit,
  order = "desc",
  retryEmptyContext = false,
  releaseThrough,
  since,
  status,
  until,
}: ListTracksOptions): Promise<FeedListPage | TrackListPage | BoardTrackListPage> {
  const db = await getDb();

  const { mapRow, trackSelect } = trackListProjection(board, lean);

  const projectedDueWorkKind = selectFindingDueWorkKind({
    captureQueue,
    hasContext,
    hasEmbedding,
    hasKey,
    hasNote,
    hasObservation,
    hasVideo,
    includeMixtapes,
    order,
    releaseThrough,
    retryEmptyContext,
    since,
    status,
    until,
  });

  const projectedPage = projectedDueWorkKind
    ? await listProjectedTracks(db, projectedDueWorkKind, {
        countTotal,
        cursor,
        limit,
        mapRow,
        trackSelect,
      })
    : undefined;
  if (projectedPage) {
    return projectedPage;
  }

  const { filterArgs, filterClauses } = buildTrackListFilters({
    captureQueue,
    hasContext,
    hasEmbedding,
    hasKey,
    hasNote,
    hasObservation,
    hasVideo,
    releaseThrough,
    retryEmptyContext,
    since,
    status,
    until,
  });

  const dir = order === "asc" ? "asc" : "desc";
  const cursorComparator =
    dir === "asc"
      ? "(findings.added_at > ? or (findings.added_at = ? and tracks.track_id > ?))"
      : "(findings.added_at < ? or (findings.added_at = ? and tracks.track_id < ?))";

  const mixtapeCursorComparator =
    dir === "asc"
      ? "(added_at > ? or (added_at = ? and log_id > ?))"
      : "(added_at < ? or (added_at = ? and log_id < ?))";

  const countWhere = filterClauses.length > 0 ? `where ${filterClauses.join(" and ")}` : "";
  const listClauses = cursor ? [...filterClauses, cursorComparator] : filterClauses;
  const where = listClauses.length > 0 ? `where ${listClauses.join(" and ")}` : "";
  const cursorArgs = cursor ? [cursor.addedAt, cursor.addedAt, cursor.trackId] : [];
  const args: Array<string | number> = [...filterArgs, ...cursorArgs, limit + 1];

  const [result, countResult] = await Promise.all([
    db.execute({
      args,
      sql: `select ${trackSelect}
            from ${FINDINGS_FROM}
            ${where}
            order by findings.added_at ${dir}, findings.track_id ${dir}
            limit ?`,
    }),
    countTotal
      ? db.execute({
          args: filterArgs,
          sql: `select count(*) as total_count from ${FINDINGS_FROM} ${countWhere}`,
        })
      : undefined,
  ]);
  const rows = typedRows<TrackRow>(result.rows);
  const feedRows = includesPublishedMixtapeFeed({ hasVideo, includeMixtapes, since, status, until })
    ? await listPublishedMixtapeFeedRows(
        db,
        cursor,
        mixtapeCursorComparator,
        cursorArgs,
        dir,
        limit,
      )
    : undefined;

  const countRows = countResult ? typedRows<TrackCountRow>(countResult.rows) : undefined;
  const totalCount = feedFindingsCount(countRows?.[0]?.total_count, rows.length);

  if (feedRows) {
    const {
      items,
      hasMore,
      nextCursor: nextRawCursor,
    } = mergeFeedPage(
      rows.map(mapRow),
      feedRows.map((row) => rowToMixtape(row)),
      dir,
      limit,
    );
    return {
      nextCursor: hasMore && nextRawCursor ? encodeTrackCursor(nextRawCursor) : undefined,
      totalCount,
      tracks: items,
    };
  }

  const visibleRows = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const lastVisibleRow = visibleRows.at(-1);
  const tracks = visibleRows.map(mapRow);

  if (captureQueue) {
    await attachArtistYoutubeChannelIds(db, tracks);
  }

  return {
    nextCursor:
      hasMore && lastVisibleRow
        ? encodeTrackCursor({
            addedAt: lastVisibleRow.added_at,
            trackId: lastVisibleRow.track_id,
          })
        : undefined,
    totalCount,
    tracks,
  };
}

async function listPublishedMixtapeFeedRows(
  db: Awaited<ReturnType<typeof getDb>>,
  cursor: TrackCursor | undefined,
  cursorComparator: string,
  cursorArgs: string[],
  dir: "asc" | "desc",
  limit: number,
): Promise<MixtapeFeedRow[]> {
  const result = await db.execute({
    args: [...cursorArgs, limit + 1],
    sql: `select
            m.id,
            m.log_id,
            m.sequence_number,
            m.title,
            m.duration_ms,
            m.note,
            (select url from mixtape_social_posts s
               where s.mixtape_id = m.id and s.platform = 'mixcloud' and s.status = 'published' and s.url is not null
               order by published_at desc limit 1) as mixcloud_url,
            (select url from mixtape_social_posts s
               where s.mixtape_id = m.id and s.platform = 'youtube' and s.status = 'published' and s.url is not null
               order by published_at desc limit 1) as youtube_url,
            (select url from mixtape_social_posts s
               where s.mixtape_id = m.id and s.platform = 'soundcloud' and s.status = 'published' and s.url is not null
               order by published_at desc limit 1) as soundcloud_url,
            m.added_at,
            m.updated_at,
            (select count(*) from mixtape_tracks mt where mt.mixtape_id = m.id) as member_count
          from mixtapes m
          where m.status = 'published'
            and m.log_id is not null
            and m.added_at is not null
            ${cursor ? `and ${cursorComparator}` : ""}
          order by m.added_at ${dir}, m.log_id ${dir}
          limit ?`,
  });

  return typedRows<MixtapeFeedRow>(result.rows);
}

function itemCursorId(item: FeedItem): string {
  return item.type === "mixtape" ? (item.logId as string) : item.trackId;
}

function compareFeedItems(left: FeedItem, right: FeedItem, dir: "asc" | "desc"): number {
  const direction = dir === "asc" ? 1 : -1;
  const byDate = binaryCompare(left.addedAt ?? "", right.addedAt ?? "");

  if (byDate !== 0) {
    return byDate * direction;
  }

  return binaryCompare(itemCursorId(left), itemCursorId(right)) * direction;
}

function binaryCompare(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function isAfterCursor(item: FeedItem, cursor: TrackCursor, dir: "asc" | "desc"): boolean {
  const itemAddedAt = item.addedAt ?? "";
  const itemId = itemCursorId(item);
  const byDate = binaryCompare(itemAddedAt, cursor.addedAt);

  if (dir === "desc") {
    if (byDate < 0) {
      return true;
    }
    if (byDate === 0) {
      return binaryCompare(itemId, cursor.trackId) < 0;
    }
    return false;
  }

  if (byDate > 0) {
    return true;
  }
  if (byDate === 0) {
    return binaryCompare(itemId, cursor.trackId) > 0;
  }
  return false;
}

export function mergeFeedPage(
  findings: FeedItem[],
  mixtapes: FeedItem[],
  dir: "asc" | "desc",
  limit: number,
  cursor?: TrackCursor,
): { items: FeedItem[]; hasMore: boolean; nextCursor?: TrackCursor } {
  const filteredFindings = cursor
    ? findings.filter((item) => isAfterCursor(item, cursor, dir))
    : findings.slice();
  const filteredMixtapes = cursor
    ? mixtapes.filter((item) => isAfterCursor(item, cursor, dir))
    : mixtapes.slice();

  const findingsPage = filteredFindings
    .sort((left, right) => compareFeedItems(left, right, dir))
    .slice(0, limit + 1);
  const mixtapesPage = filteredMixtapes
    .sort((left, right) => compareFeedItems(left, right, dir))
    .slice(0, limit + 1);

  const merged = [...findingsPage, ...mixtapesPage]
    .sort((left, right) => compareFeedItems(left, right, dir))
    .slice(0, limit + 1);

  const items = merged.slice(0, limit);
  const hasMore = merged.length > limit;
  const lastVisible = items.at(-1);
  const nextCursor =
    hasMore && lastVisible
      ? { addedAt: lastVisible.addedAt ?? "", trackId: itemCursorId(lastVisible) }
      : undefined;

  return { hasMore, items, nextCursor };
}

export function feedFindingsCount(sqlCount: number | undefined, fallback: number): number {
  return Number(sqlCount ?? fallback);
}

export function decodeTrackCursor(value: string | null): TrackCursor | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as TrackCursor;

    if (typeof parsed.addedAt === "string" && typeof parsed.trackId === "string") {
      return parsed;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function encodeTrackCursor(cursor: TrackCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
