import { type FreshTrack } from "@fluncle/contracts";
import { bestAlbumCoverUrl, bestArtistAvatarUrl } from "../media";
import { hasPreviewSource } from "../track-preview";
import { parseArtistsJson } from "./artists";
import { listedArtistWhere } from "./artist-visibility";
import { getDb, typedRows } from "./db";
import { datedReleaseByTodaySql, releaseTodayUtc, releaseWindowLowerBound } from "./release-day";
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

export const FRESH_WINDOW_DAYS = 30;

export const FRESH_RECORDS_WINDOW_DAYS = 90;

export const FRESH_WEEK_DAYS = 7;

export const FRESH_FINDINGS_LIMIT = 60;
export const FRESH_CATALOGUE_LIMIT = 60;
export const FRESH_RECORDS_LIMIT = 24;

export type FreshBucket = "earlier" | "week";

export type FreshCatalogueItem = CatalogueTrackItem & {
  artistAvatarUrl?: string;
  releaseDate: string;
};

export type FreshFinding = TrackListItem & { artistAvatarUrl?: string };

export type FreshSection = {
  catalogue: FreshCatalogueItem[];
  findings: FreshFinding[];
  key: FreshBucket;
};

export type FreshRecord = {
  artists: string[];

  coverImageUrl: string | undefined;
  name: string;
  releaseDate: string;

  slug: string;

  trackCount: number;

  withinTrackWindow: boolean;
};

export type FreshReleases = {
  records: FreshRecord[];

  sections: FreshSection[];

  windowDays: number;
};

type FreshCatalogueRow = LeadArtistRow & {
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

export async function listFreshReleases(
  now: Date = new Date(),
  recordsWindowDays: number = FRESH_WINDOW_DAYS,
): Promise<FreshReleases> {
  const db = await getDb();

  const windowStart = releaseWindowLowerBound(dayString(now, FRESH_WINDOW_DAYS));

  const recordsWindowStart = releaseWindowLowerBound(
    dayString(now, Math.max(recordsWindowDays, FRESH_WINDOW_DAYS)),
  );
  const weekStart = releaseWindowLowerBound(dayString(now, FRESH_WEEK_DAYS));
  const today = releaseTodayUtc(now);

  const [findingsResult, catalogueResult, recordsResult] = await Promise.all([
    db.execute({
      args: [windowStart, today, FRESH_FINDINGS_LIMIT],
      sql: `select ${LEAN_TRACK_SELECT}, ${LEAD_ARTIST_SELECT} from ${FINDINGS_FROM}
            ${LEAD_ARTIST_JOIN}
            where tracks.release_date >= ? and ${datedReleaseByTodaySql("tracks.release_date")}
            order by tracks.release_date desc, tracks.track_id desc
            limit ?`,
    }),

    db.execute({
      args: [windowStart, today, FRESH_CATALOGUE_LIMIT],
      sql: `select tracks.track_id, tracks.title, tracks.artists_json,
                   tracks.spotify_url, tracks.release_date, tracks.album_image_url,
                   tracks.duration_ms, tracks.bpm, tracks.key, tracks.preview_url, tracks.isrc,
                   -- The album's owned cover master: a primary-key lookup per EMITTED row (the
                   -- index-ordered scan stops at the limit), so a record whose raw cover is gone
                   -- still shows its master here as it does on the hub and the entity pages.
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

    db.execute({
      args: [recordsWindowStart, today, FRESH_RECORDS_LIMIT],
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
    }),
  ]);

  const findings: FreshFinding[] = typedRows<TrackRow & LeadArtistRow>(findingsResult.rows).map(
    (row) => ({
      ...toPublicTrackListItem(toTrackListItem(row)),
      artistAvatarUrl: leadArtistAvatarUrl(row),
    }),
  );
  const catalogue: FreshCatalogueItem[] = typedRows<FreshCatalogueRow>(catalogueResult.rows).map(
    (row) => ({
      albumImageUrl: bestAlbumCoverUrl({
        imageKey: row.album_image_key,
        imageState: row.album_image_state,
        imageUpdatedAt: row.album_image_updated_at,
        spotifyUrl: row.album_image_url,
      }),
      artistAvatarUrl: leadArtistAvatarUrl(row),
      artists: parseArtistsJson(row.artists_json),
      bpm: row.bpm ?? undefined,
      durationMs: row.duration_ms || undefined,
      key: row.key ?? undefined,
      previewable: hasPreviewSource({ isrc: row.isrc, previewUrl: row.preview_url }),
      releaseDate: row.release_date,
      spotifyUrl: row.spotify_url ?? undefined,
      title: row.title,
      trackId: row.track_id,
    }),
  );
  const records: FreshRecord[] = typedRows<FreshRecordRow>(recordsResult.rows).map((row) => ({
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

    withinTrackWindow: row.release_date >= windowStart,
  }));

  const sections: FreshSection[] = (["week", "earlier"] as const).flatMap((key) => {
    const inWeek = (date: string | undefined): boolean => (date ?? "") >= weekStart;
    const sectionFindings = findings.filter((finding) =>
      key === "week" ? inWeek(finding.releaseDate) : !inWeek(finding.releaseDate),
    );
    const sectionCatalogue = catalogue.filter((track) =>
      key === "week" ? inWeek(track.releaseDate) : !inWeek(track.releaseDate),
    );

    return sectionFindings.length === 0 && sectionCatalogue.length === 0
      ? []
      : [{ catalogue: sectionCatalogue, findings: sectionFindings, key }];
  });

  return { records, sections, windowDays: FRESH_WINDOW_DAYS };
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
  const data = await listFreshReleases(options?.now);

  const findings: FreshTrack[] = data.sections.flatMap((section) =>
    section.findings.map((finding) => ({
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
    })),
  );
  const catalogue: FreshTrack[] = data.sections.flatMap((section) =>
    section.catalogue.map((track) => ({
      artists: track.artists,
      certified: false,
      releaseDate: track.releaseDate,
      spotifyUrl: track.spotifyUrl,
      title: track.title,
    })),
  );

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

  return { albums: data.records, tracks, windowDays: data.windowDays };
}
