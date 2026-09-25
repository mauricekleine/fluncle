import { type FreshTrack } from "@fluncle/contracts";
import { bestAlbumCoverUrl, bestArtistAvatarUrl } from "../media";
import { hasPreviewSource } from "../track-preview";
import { parseArtistsJson } from "./artists";
import { listedArtistWhere } from "./artist-visibility";
import { getDb, typedRows } from "./db";
import {
  datedReleaseByTodaySql,
  FRESH_WINDOW_DAYS,
  releaseTodayUtc,
  releaseWindowLowerBound,
} from "./release-day";
import {
  type CatalogueTrackItem,
  FINDINGS_FROM,
  LEAN_TRACK_SELECT,
  type TrackListItem,
  toPublicTrackListItem,
  toTrackListItem,
  type TrackRow,
} from "./tracks";

export const LEAD_ARTIST_JOIN = `left join artists fresh_lead_artist on fresh_lead_artist.id = (
        select ta.artist_id from track_artists ta
        where ta.track_id = tracks.track_id
        order by ta.position asc limit 1)
      and ${listedArtistWhere("fresh_lead_artist")}`;
export const LEAD_ARTIST_SELECT = `fresh_lead_artist.image_url as artist_image_url,
       fresh_lead_artist.image_key as artist_image_key,
       fresh_lead_artist.image_state as artist_image_state,
       fresh_lead_artist.image_updated_at as artist_image_updated_at`;

export type LeadArtistRow = {
  artist_image_key: string | null;
  artist_image_state: string | null;
  artist_image_updated_at: string | null;
  artist_image_url: string | null;
};

export function leadArtistAvatarUrl(row: LeadArtistRow): string | undefined {
  return bestArtistAvatarUrl({
    imageKey: row.artist_image_key,
    imageState: row.artist_image_state,
    imageUpdatedAt: row.artist_image_updated_at,
    imageUrl: row.artist_image_url,
  });
}

export { FRESH_WINDOW_DAYS } from "./release-day";

export const FRESH_FINDINGS_LIMIT = 60;
export const FRESH_CATALOGUE_LIMIT = 300;

export const FRESH_RECORDS_LIMIT = 24;

export type FreshCatalogueItem = CatalogueTrackItem & {
  album?: string;

  albumSlug?: string;

  albumTrackCount?: number;
  artistAvatarUrl?: string;

  isrc?: string;
  releaseDate: string;
};

export type FreshFinding = TrackListItem & {
  albumTrackCount?: number;
  artistAvatarUrl?: string;
};

export type FreshCoverage =
  | { kind: "complete" }
  | { kind: "partial"; since: string }
  | { kind: "truncated"; day: string };

export type FreshRecord = {
  artists: string[];

  coverImageUrl: string | undefined;
  name: string;
  releaseDate: string;

  slug: string;

  trackCount: number;
};

export type FreshReleases = {
  catalogue: FreshCatalogueItem[];
  coverage: FreshCoverage;

  findings: FreshFinding[];

  windowDays: number;
};

type FreshCatalogueRow = LeadArtistRow & {
  album: string | null;
  album_image_key: string | null;
  album_image_state: string | null;
  album_image_updated_at: string | null;
  album_image_url: string | null;
  album_slug: string | null;
  album_track_count: number | null;
  artists_json: string;
  bpm: number | null;
  duration_ms: number;
  isrc: string | null;
  key: string | null;
  preview_url: string | null;
  release_date: string;
  spotify_url: string | null;
  title: string;
  track_id: string;
};

type FreshRecordRow = {
  artists: string | null;
  cover_url: string | null;
  image_key: string | null;
  image_state: string | null;
  image_updated_at: string | null;
  name: string;
  release_date: string;
  slug: string;
  track_count: number;
};

function dayString(now: Date, daysAgo: number): string {
  return new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function freshWindow(now: Date): { today: string; windowStart: string } {
  return {
    today: releaseTodayUtc(now),
    windowStart: releaseWindowLowerBound(dayString(now, FRESH_WINDOW_DAYS)),
  };
}

function limitCut(rows: { releaseDate?: string }[], limit: number): string | undefined {
  return rows.length > limit ? (rows[limit]?.releaseDate ?? "") : undefined;
}

function trimToCoverage(
  findings: FreshFinding[],
  catalogue: FreshCatalogueItem[],
  limits: { catalogue: number; findings: number },
): { catalogue: FreshCatalogueItem[]; coverage: FreshCoverage; findings: FreshFinding[] } {
  const cuts = [limitCut(findings, limits.findings), limitCut(catalogue, limits.catalogue)].filter(
    (cut): cut is string => cut !== undefined,
  );

  if (cuts.length === 0) {
    return { catalogue, coverage: { kind: "complete" }, findings };
  }

  const floor = cuts.reduce((newest, cut) => (cut > newest ? cut : newest));
  const keptFindings = findings.filter((finding) => (finding.releaseDate ?? "") > floor);
  const keptCatalogue = catalogue.filter((track) => track.releaseDate > floor);
  const oldest = [
    ...keptFindings.map((finding) => finding.releaseDate ?? ""),
    ...keptCatalogue.map((track) => track.releaseDate),
  ]
    .filter(Boolean)
    .reduce<string | undefined>(
      (min, date) => (min === undefined || date < min ? date : min),
      undefined,
    );

  if (oldest === undefined) {
    return {
      catalogue: catalogue
        .filter((track) => track.releaseDate === floor)
        .slice(0, limits.catalogue),
      coverage: { day: floor, kind: "truncated" },
      findings: findings
        .filter((finding) => finding.releaseDate === floor)
        .slice(0, limits.findings),
    };
  }

  return {
    catalogue: keptCatalogue,
    coverage: { kind: "partial", since: oldest },
    findings: keptFindings,
  };
}

export async function listFreshReleases(
  now: Date = new Date(),
  options?: { catalogueLimit?: number },
): Promise<FreshReleases> {
  const db = await getDb();

  const { today, windowStart } = freshWindow(now);
  const catalogueLimit = Math.min(
    options?.catalogueLimit ?? FRESH_CATALOGUE_LIMIT,
    FRESH_CATALOGUE_LIMIT,
  );

  const [findingsResult, catalogueResult] = await Promise.all([
    db.execute({
      args: [windowStart, today, FRESH_FINDINGS_LIMIT + 1],
      sql: `select ${LEAN_TRACK_SELECT}, ${LEAD_ARTIST_SELECT},
                   (select renderable_track_count from albums where albums.id = tracks.album_id) as album_track_count
            from ${FINDINGS_FROM}
            ${LEAD_ARTIST_JOIN}
            where tracks.release_date >= ? and ${datedReleaseByTodaySql("tracks.release_date")}
            order by tracks.release_date desc, tracks.track_id desc
            limit ?`,
    }),

    db.execute({
      args: [windowStart, today, catalogueLimit + 1],
      sql: `select tracks.track_id, tracks.title, tracks.artists_json, tracks.album,
                   tracks.spotify_url, tracks.release_date, tracks.album_image_url,
                   tracks.duration_ms, tracks.bpm, tracks.key, tracks.preview_url, tracks.isrc,
                   -- The album entity: its slug keys the page's release grouping, and its owned
                   -- cover master shows here as it does on the hub and the entity pages. Each is
                   -- a primary-key lookup per EMITTED row (the index-ordered scan stops at the
                   -- limit).
                   (select slug from albums where albums.id = tracks.album_id) as album_slug,
                   (select renderable_track_count from albums where albums.id = tracks.album_id) as album_track_count,
                   (select image_key from albums where albums.id = tracks.album_id) as album_image_key,
                   (select image_state from albums where albums.id = tracks.album_id) as album_image_state,
                   (select image_updated_at from albums where albums.id = tracks.album_id) as album_image_updated_at,
                   ${LEAD_ARTIST_SELECT}
            from tracks
            ${LEAD_ARTIST_JOIN}
            where tracks.is_catalogue = 1
              and tracks.release_date >= ? and ${datedReleaseByTodaySql("tracks.release_date")}
            order by tracks.release_date desc, tracks.track_id desc
            limit ?`,
    }),
  ]);

  const findings: FreshFinding[] = typedRows<
    TrackRow & LeadArtistRow & { album_track_count: number | null }
  >(findingsResult.rows).map((row) => ({
    ...toPublicTrackListItem(toTrackListItem(row)),
    albumTrackCount: row.album_track_count ?? undefined,
    artistAvatarUrl: leadArtistAvatarUrl(row),
  }));
  const catalogue: FreshCatalogueItem[] = typedRows<FreshCatalogueRow>(catalogueResult.rows).map(
    (row) => ({
      album: row.album ?? undefined,
      albumImageUrl: bestAlbumCoverUrl({
        imageKey: row.album_image_key,
        imageState: row.album_image_state,
        imageUpdatedAt: row.album_image_updated_at,
        spotifyUrl: row.album_image_url,
      }),
      albumSlug: row.album_slug ?? undefined,
      albumTrackCount: row.album_track_count ?? undefined,
      artistAvatarUrl: leadArtistAvatarUrl(row),
      artists: parseArtistsJson(row.artists_json),
      bpm: row.bpm ?? undefined,
      durationMs: row.duration_ms || undefined,
      isrc: row.isrc ?? undefined,
      key: row.key ?? undefined,
      previewable: hasPreviewSource({ isrc: row.isrc, previewUrl: row.preview_url }),
      releaseDate: row.release_date,
      spotifyUrl: row.spotify_url ?? undefined,
      title: row.title,
      trackId: row.track_id,
    }),
  );

  return {
    ...trimToCoverage(findings, catalogue, {
      catalogue: catalogueLimit,
      findings: FRESH_FINDINGS_LIMIT,
    }),
    windowDays: FRESH_WINDOW_DAYS,
  };
}

export async function listFreshRecords(now: Date = new Date()): Promise<FreshRecord[]> {
  const db = await getDb();
  const { today, windowStart } = freshWindow(now);
  const result = await db.execute({
    args: [windowStart, today, FRESH_RECORDS_LIMIT],
    sql: `select al.slug as slug, min(al.name) as name,
                 max(tracks.release_date) as release_date,
                 count(distinct tracks.track_id) as track_count,
                 group_concat(distinct credit.value) as artists,
                 al.image_key as image_key, al.image_state as image_state,
                 al.image_updated_at as image_updated_at,
                 (select t2.album_image_url
                    from tracks t2
                    where t2.album_id = al.id and t2.album_image_url is not null
                    order by t2.release_date is null asc, t2.release_date desc, t2.track_id asc
                    limit 1) as cover_url
          from tracks
          join albums al on al.id = tracks.album_id
          join json_each(tracks.artists_json) credit
          where tracks.release_date >= ? and ${datedReleaseByTodaySql("tracks.release_date")}
          group by al.id
          order by max(tracks.release_date) desc, min(al.name) collate nocase asc
          limit ?`,
  });

  return typedRows<FreshRecordRow>(result.rows).map((row) => ({
    artists: (row.artists ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
    coverImageUrl: bestAlbumCoverUrl({
      imageKey: row.image_key,
      imageState: row.image_state,
      imageUpdatedAt: row.image_updated_at,
      spotifyUrl: row.cover_url,
    }),
    name: row.name,
    releaseDate: row.release_date,
    slug: row.slug,
    trackCount: row.track_count,
  }));
}

export const FRESH_TRACKS_DEFAULT = 50;
export const FRESH_TRACKS_MAX = 100;

export type { FreshTrack };

export type FreshTracks = {
  albums: FreshRecord[];
  tracks: FreshTrack[];
  windowDays: number;
};

export function clampFreshLimit(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return FRESH_TRACKS_DEFAULT;
  }
  return Math.max(1, Math.min(FRESH_TRACKS_MAX, Math.floor(limit)));
}

export async function listFreshTracks(options?: {
  limit?: number;
  now?: Date;
}): Promise<FreshTracks> {
  const limit = clampFreshLimit(options?.limit);
  const [data, records] = await Promise.all([
    listFreshReleases(options?.now),
    listFreshRecords(options?.now),
  ]);

  const findings: FreshTrack[] = data.findings.map((finding) => ({
    artists: finding.artists,
    bpm: finding.bpm,
    certified: true,
    coverImageUrl: finding.albumImageUrl,
    durationMs: finding.durationMs,
    key: finding.key,
    logId: finding.logId,
    releaseDate: finding.releaseDate ?? "",
    spotifyUrl: finding.spotifyUrl,
    title: finding.title,
  }));
  const catalogue: FreshTrack[] = data.catalogue.map((track) => ({
    artists: track.artists,
    certified: false,
    releaseDate: track.releaseDate,
    spotifyUrl: track.spotifyUrl,
    title: track.title,
  }));

  const tracks = [...findings, ...catalogue]
    .sort((a, b) => {
      if (a.releaseDate !== b.releaseDate) {
        return a.releaseDate < b.releaseDate ? 1 : -1;
      }
      if (a.certified !== b.certified) {
        return a.certified ? -1 : 1;
      }
      return a.title.localeCompare(b.title);
    })
    .slice(0, limit);

  return { albums: records, tracks, windowDays: data.windowDays };
}
