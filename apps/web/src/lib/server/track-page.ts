import { readEmbeddingBlob, toVectorProbe } from "./embedding";
import { getDb, typedRow, typedRows } from "./db";
import { isSonarTrackEnabled, searchSonar, type SonarFilter, type SonarMatch } from "./sonar";
import { hydrateRankedSonarMatches } from "./sonar-hydration";
import { executeVectorFallback, vectorFallbackCandidateLimitSql } from "./vector-fallback";
import { bestAlbumCoverUrl } from "../media";
import { hasPreviewSource } from "../track-preview";
import { type ListenKind } from "../track-page";
import { discogsReleaseUrl } from "./discogs";
import { parseArtistsJson } from "./artists";
import { listedArtistWhere } from "./artist-visibility";
import {
  TRACK_PAGE_INDEXABLE_COVER_COUNT_INDEX,
  trackPageIdentityWhere,
  trackPageIndexableCountQueryWhere,
  trackPageIndexableWhere,
} from "../../db/track-page-indexability";
import { publicTrackDurationOk, publicTrackDurationWhere } from "../../db/public-track-visibility";
import { LONG_FORM_MS } from "../catalogue-eligibility";

export const TRACK_PAGE_IDENTITY_WHERE = trackPageIdentityWhere("tracks");

export const TRACK_PAGE_INDEXABLE_WHERE = trackPageIndexableWhere("tracks");

export type ListenDestination = {
  href: string;

  kind: ListenKind;
};

export type TrackGraphLink = { name: string; slug: string | undefined };

export type SonicNeighbour = {
  albumImageUrl: string | undefined;
  artists: string[];

  bpm?: number;
  durationMs?: number;
  key?: string;
  logId: string | undefined;
  previewable: boolean;
  releaseDate?: string;
  spotifyUrl?: string;
  title: string;
  trackId: string;
};

export type TrackDestination = {
  album: TrackGraphLink | undefined;
  albumImageUrl: string | undefined;
  artists: TrackGraphLink[];
  bpm: number | undefined;

  discogsReleaseUrl: string | undefined;

  durationMs: number | undefined;

  indexable: boolean;
  isrc: string | undefined;
  key: string | undefined;
  label: TrackGraphLink | undefined;
  listen: ListenDestination[];
  mbRecordingId: string | undefined;

  previewable: boolean;
  releaseDate: string | undefined;
  title: string;
  trackId: string;
};

export type TrackPageRow =
  | { kind: "found"; track: TrackDestination }
  | { kind: "duplicate"; principalTrackId: string }
  | { kind: "certified"; logId: string }
  | { kind: "missing" };

type DestinationRow = {
  album_image_key: string | null;
  album_image_state: string | null;
  album_image_updated_at: string | null;
  album_image_url: string | null;
  album_name: string | null;
  album_slug: string | null;
  apple_music_url: string | null;
  artist_slugs_json: string | null;
  artists_json: string;
  beatport_url: string | null;
  bpm: number | null;
  deezer_track_id: string | null;
  dismissed_at: string | null;
  duplicate_of_track_id: string | null;
  duration_ms: number;
  in_release_id: number | null;
  indexable: number;
  isrc: string | null;
  key: string | null;
  label: string | null;
  label_slug: string | null;
  log_id: string | null;
  mb_recording_id: string | null;
  preview_url: string | null;
  principal_log_id: string | null;
  release_date: string | null;
  title: string;
  track_id: string;
  youtube_video_id: string | null;
  youtube_video_official: number | null;
};

const ARTIST_SLUGS_SELECT = `(select json_group_array(json_object('name', a.name, 'slug', a.slug))
     from track_artists ta join artists a on a.id = ta.artist_id
     where ta.track_id = tracks.track_id and ${listedArtistWhere("a")}) as artist_slugs_json`;

const DESTINATION_SELECT = `tracks.track_id, tracks.title, tracks.artists_json, tracks.album_image_url,
  tracks.bpm, tracks.key, tracks.duration_ms, tracks.release_date, tracks.isrc, tracks.mb_recording_id,
  tracks.label, tracks.preview_url, tracks.spotify_url, tracks.apple_music_url, tracks.beatport_url,
  tracks.deezer_track_id, tracks.youtube_video_id, tracks.youtube_video_official, tracks.in_release_id,
  tracks.dismissed_at, tracks.duplicate_of_track_id, findings.log_id,
  (select name from albums where albums.id = tracks.album_id) as album_name,
  (select slug from albums where albums.id = tracks.album_id) as album_slug,
  (select image_key from albums where albums.id = tracks.album_id) as album_image_key,
  (select image_state from albums where albums.id = tracks.album_id) as album_image_state,
  (select image_updated_at from albums where albums.id = tracks.album_id) as album_image_updated_at,
  (select slug from labels where labels.id = tracks.label_id) as label_slug,
  ${ARTIST_SLUGS_SELECT},
  (select log_id from findings where findings.track_id = tracks.duplicate_of_track_id)
    as principal_log_id,
  (case when ${TRACK_PAGE_INDEXABLE_WHERE} then 1 else 0 end) as indexable`;

function artistSlugMap(json: string | null): Map<string, string> {
  const map = new Map<string, string>();

  if (!json) {
    return map;
  }

  try {
    const parsed: unknown = JSON.parse(json);

    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const name = (entry as Record<string, unknown>)["name"];
        const slug = (entry as Record<string, unknown>)["slug"];

        if (typeof name === "string" && typeof slug === "string" && slug) {
          map.set(name.trim().toLowerCase(), slug);
        }
      }
    }
  } catch {
    return map;
  }

  return map;
}

function listenDestinations(row: DestinationRow, spotifyUrl: string | null): ListenDestination[] {
  const destinations: ListenDestination[] = [];

  if (spotifyUrl) {
    destinations.push({ href: spotifyUrl, kind: "spotify" });
  }

  if (row.apple_music_url) {
    destinations.push({ href: row.apple_music_url, kind: "apple" });
  }

  if (row.deezer_track_id) {
    destinations.push({
      href: `https://www.deezer.com/track/${encodeURIComponent(row.deezer_track_id)}`,
      kind: "deezer",
    });
  }

  if (row.beatport_url) {
    destinations.push({ href: row.beatport_url, kind: "beatport" });
  }

  if (row.youtube_video_id && row.youtube_video_official === 1) {
    destinations.push({
      href: `https://www.youtube.com/watch?v=${encodeURIComponent(row.youtube_video_id)}`,
      kind: "youtube",
    });
  }

  return destinations;
}

function graphLink(name: string | null, slug: string | null): TrackGraphLink | undefined {
  return name?.trim() ? { name, slug: slug ?? undefined } : undefined;
}

export async function readTrackDestination(trackId: string): Promise<TrackPageRow> {
  const db = await getDb();
  const result = await db.execute({
    args: [trackId],
    sql: `select ${DESTINATION_SELECT}, tracks.spotify_url as spotify_url
          from tracks
          left join findings on findings.track_id = tracks.track_id
          where tracks.track_id = ?
          limit 1`,
  });
  const row = typedRow<DestinationRow & { spotify_url: string | null }>(result.rows);

  if (!row) {
    return { kind: "missing" };
  }

  if (row.log_id) {
    return { kind: "certified", logId: row.log_id };
  }

  if (row.duplicate_of_track_id) {
    return row.principal_log_id
      ? { kind: "certified", logId: row.principal_log_id }
      : { kind: "duplicate", principalTrackId: row.duplicate_of_track_id };
  }

  if (!publicTrackDurationOk(row.duration_ms, false)) {
    return { kind: "missing" };
  }

  const artistNames = parseArtistsJson(row.artists_json);

  if (row.dismissed_at || !row.title.trim() || artistNames.length === 0) {
    return { kind: "missing" };
  }

  const slugs = artistSlugMap(row.artist_slugs_json);

  return {
    kind: "found",
    track: {
      album: graphLink(row.album_name, row.album_slug),

      albumImageUrl: bestAlbumCoverUrl({
        imageKey: row.album_image_key,
        imageState: row.album_image_state,
        imageUpdatedAt: row.album_image_updated_at,
        spotifyUrl: row.album_image_url,
      }),
      artists: artistNames.map((name) => ({
        name,
        slug: slugs.get(name.trim().toLowerCase()),
      })),
      bpm: row.bpm ?? undefined,
      discogsReleaseUrl:
        row.in_release_id === null ? undefined : discogsReleaseUrl(row.in_release_id),
      durationMs: row.duration_ms > 0 ? row.duration_ms : undefined,
      indexable: row.indexable === 1,

      isrc: row.isrc?.trim() ? row.isrc.trim() : undefined,
      key: row.key?.trim() ? row.key.trim() : undefined,
      label: graphLink(row.label, row.label_slug),
      listen: listenDestinations(row, row.spotify_url),
      mbRecordingId: row.mb_recording_id?.trim() ? row.mb_recording_id.trim() : undefined,

      previewable: hasPreviewSource({ isrc: row.isrc, previewUrl: row.preview_url }),
      releaseDate: row.release_date ?? undefined,
      title: row.title,
      trackId: row.track_id,
    },
  };
}

export const SONIC_NEIGHBOUR_LIMIT = 8;

type NeighbourRow = {
  album_image_key: string | null;
  album_image_state: string | null;
  album_image_updated_at: string | null;
  album_image_url: string | null;
  artists_json: string;
  bpm: number | null;
  duration_ms: number;
  isrc: string | null;
  key: string | null;
  log_id: string | null;
  preview_url: string | null;
  release_date: string | null;
  spotify_url: string | null;
  title: string;
  track_id: string;
};

const NEIGHBOUR_SELECT = `tracks.track_id, tracks.title, tracks.artists_json, tracks.album_image_url,
  tracks.preview_url, tracks.isrc, tracks.spotify_url, tracks.bpm, tracks.key, tracks.duration_ms,
  tracks.release_date,
  (select image_key from albums where albums.id = tracks.album_id) as album_image_key,
  (select image_state from albums where albums.id = tracks.album_id) as album_image_state,
  (select image_updated_at from albums where albums.id = tracks.album_id) as album_image_updated_at,
  findings.log_id`;

const NEIGHBOUR_WHERE = `${TRACK_PAGE_IDENTITY_WHERE} and tracks.duplicate_of_track_id is null and ${publicTrackDurationWhere("tracks", "findings")}`;

function toNeighbour(row: NeighbourRow): SonicNeighbour {
  return {
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
    logId: row.log_id ?? undefined,
    previewable: hasPreviewSource({ isrc: row.isrc, previewUrl: row.preview_url }),
    releaseDate: row.release_date ?? undefined,
    spotifyUrl: row.spotify_url ?? undefined,
    title: row.title,
    trackId: row.track_id,
  };
}

export async function listSonicNeighbours(
  trackId: string,
  limit = SONIC_NEIGHBOUR_LIMIT,
  options: { allowBoundedSql?: boolean } = {},
): Promise<SonicNeighbour[]> {
  if (limit <= 0) {
    return [];
  }

  const sonarEnabled = await isSonarTrackEnabled();

  if (!sonarEnabled && options.allowBoundedSql !== true) {
    return [];
  }

  const db = await getDb();

  const targetResult = await db.execute({
    args: [trackId],
    sql: `select emb.embedding_blob, tracks.bpm
          from track_embeddings emb
          join tracks on tracks.track_id = emb.track_id
          where emb.track_id = ?
          limit 1`,
  });
  const targetRow = typedRow<{ bpm: number | null; embedding_blob: unknown }>(targetResult.rows);
  const target = readEmbeddingBlob(targetRow?.embedding_blob);

  if (!target) {
    return [];
  }

  const targetBpm = targetRow?.bpm ?? undefined;

  if (sonarEnabled) {
    const fromSonar = await sonarNeighbours(target, targetBpm, trackId, limit);

    return fromSonar === null ? [] : hydrateNeighbours(fromSonar);
  }

  const probe = toVectorProbe(target);
  const windowed = targetBpm
    ? await scanNeighbours(db, probe, trackId, limit, [
        targetBpm * (1 - NEIGHBOUR_BPM_TOLERANCE),
        targetBpm * (1 + NEIGHBOUR_BPM_TOLERANCE),
      ])
    : undefined;

  if (windowed && windowed.length >= limit) {
    return windowed.map((row) => toNeighbour(row));
  }

  const widened = await scanNeighbours(db, probe, trackId, limit, undefined);

  return widened.map((row) => toNeighbour(row));
}

const NEIGHBOUR_BPM_TOLERANCE = 0.08;

async function scanNeighbours(
  db: Awaited<ReturnType<typeof getDb>>,
  probe: Uint8Array,
  trackId: string,
  limit: number,
  bpmWindow: [number, number] | undefined,
): Promise<NeighbourRow[]> {
  const result = await executeVectorFallback(
    db,
    "sonar.fallback.track",
    sonicNeighbourScanStatement(probe, trackId, limit, bpmWindow),
  );

  return typedRows<NeighbourRow>(result.rows);
}

export function sonicNeighbourScanStatement(
  probe: Uint8Array,
  trackId: string,
  limit: number,
  bpmWindow: [number, number] | undefined,
) {
  return {
    args: bpmWindow ? [trackId, bpmWindow[0], bpmWindow[1], probe, limit] : [trackId, probe, limit],
    sql: `with candidates(track_id) as materialized (
              select tracks.track_id
              from tracks${bpmWindow ? " indexed by tracks_bpm_idx" : ""}
              join track_embeddings emb on emb.track_id = tracks.track_id
              left join findings on findings.track_id = tracks.track_id
              where tracks.track_id != ? and ${NEIGHBOUR_WHERE}
                    ${bpmWindow ? "and tracks.bpm between ? and ?" : ""}
              order by tracks.track_id
              ${vectorFallbackCandidateLimitSql()}
            ), winners(track_id, dist) as materialized (
            select candidates.track_id, vector_distance_cos(emb.embedding_blob, ?) as dist
            from candidates
            join track_embeddings emb on emb.track_id = candidates.track_id
            order by dist asc, candidates.track_id asc
            limit ?
          )
          select ${NEIGHBOUR_SELECT}
          from winners
          cross join tracks on tracks.track_id = winners.track_id
          left join findings on findings.track_id = tracks.track_id
          order by winners.dist asc, winners.track_id asc`,
  };
}

async function sonarNeighbours(
  target: number[],
  targetBpm: number | undefined,
  trackId: string,
  limit: number,
): Promise<SonarMatch[] | null> {
  if (targetBpm) {
    const windowed = await searchPublicSonarNeighbours(target, trackId, limit, {
      bpm_max: targetBpm * (1 + NEIGHBOUR_BPM_TOLERANCE),
      bpm_min: targetBpm * (1 - NEIGHBOUR_BPM_TOLERANCE),
    });

    if (windowed === null) {
      return null;
    }

    if (windowed.length >= limit) {
      return windowed;
    }
  }

  return searchPublicSonarNeighbours(target, trackId, limit, {});
}

async function searchPublicSonarNeighbours(
  target: number[],
  trackId: string,
  limit: number,
  filter: SonarFilter,
): Promise<SonarMatch[] | null> {
  const request = {
    excludeIds: [trackId],
    index: "tracks" as const,
    probes: [target],
    topK: limit,
  };
  const baseFilter = { ...filter, dismissed: false, is_duplicate: false };
  const [findings, catalogue] = await Promise.all([
    searchSonar({ ...request, filter: { ...baseFilter, has_finding: true } }),
    searchSonar({
      ...request,
      filter: { ...baseFilter, duration_ms_max: LONG_FORM_MS, has_finding: false },
    }),
  ]);

  if (findings === null || catalogue === null) {
    return null;
  }

  const seen = new Set<string>();

  return [...findings, ...catalogue]
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .filter((match) => {
      if (seen.has(match.id)) {
        return false;
      }

      seen.add(match.id);
      return true;
    })
    .slice(0, limit);
}

async function hydrateNeighbours(matches: SonarMatch[]): Promise<SonicNeighbour[]> {
  return hydrateRankedSonarMatches(
    matches,
    async (ids) => {
      const placeholders = ids.map(() => "?").join(", ");
      const db = await getDb();
      const result = await db.execute({
        args: ids,
        sql: `select ${NEIGHBOUR_SELECT}
              from tracks
              left join findings on findings.track_id = tracks.track_id
              where tracks.track_id in (${placeholders}) and ${NEIGHBOUR_WHERE}`,
      });

      return typedRows<NeighbourRow>(result.rows);
    },
    (row) => row.track_id,
    (row) => toNeighbour(row),
  );
}

export type TrackSitemapRow = { imageLoc: string | undefined; trackId: string };

export async function countIndexableTrackPages(): Promise<number> {
  const db = await getDb();
  const result = await db.execute(trackSitemapIndexCountStatement());

  return Number(typedRow<{ total: number }>(result.rows)?.total ?? 0);
}

export function trackSitemapIndexCountStatement() {
  return {
    args: [],
    sql: `select coalesce(sum(total), 0) as total from (
        select count(*) as total from tracks indexed by ${TRACK_PAGE_INDEXABLE_COVER_COUNT_INDEX}
        where ${trackPageIndexableCountQueryWhere("spotify", "tracks")}
        union all
        select count(*) as total from tracks indexed by ${TRACK_PAGE_INDEXABLE_COVER_COUNT_INDEX}
        where ${trackPageIndexableCountQueryWhere("appleOnly", "tracks")}
      )`,
  };
}

export function trackSitemapWindowStatement(limit: number, afterTrackId?: string) {
  const seek = afterTrackId === undefined ? "tracks.track_id >= ?" : "tracks.track_id > ?";

  return {
    args: [afterTrackId ?? "", limit],
    sql: `select tracks.track_id, tracks.album_image_url,
                 (select image_key from albums where albums.id = tracks.album_id) as album_image_key,
                 (select image_state from albums where albums.id = tracks.album_id) as album_image_state,
                 (select image_updated_at from albums where albums.id = tracks.album_id) as album_image_updated_at
          from tracks
          where ${seek} and ${TRACK_PAGE_INDEXABLE_WHERE}
          order by tracks.track_id
          limit ?`,
  };
}

export async function listTrackSitemapRows(
  limit: number,
  afterTrackId?: string,
): Promise<TrackSitemapRow[]> {
  const db = await getDb();
  const result = await db.execute(trackSitemapWindowStatement(limit, afterTrackId));

  return typedRows<{
    album_image_key: string | null;
    album_image_state: string | null;
    album_image_updated_at: string | null;
    album_image_url: string | null;
    track_id: string;
  }>(result.rows).map((row) => ({
    imageLoc: bestAlbumCoverUrl({
      imageKey: row.album_image_key,
      imageState: row.album_image_state,
      imageUpdatedAt: row.album_image_updated_at,
      spotifyUrl: row.album_image_url,
    }),
    trackId: row.track_id,
  }));
}
