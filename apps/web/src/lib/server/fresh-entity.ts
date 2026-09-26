import { getPublicArtistBySlug, parseArtistsJson } from "./artists";
import { getDb, typedRows } from "./db";
import { clampFreshLimit, FRESH_WINDOW_DAYS, type FreshTrack } from "./fresh";
import { getLabelBySlug } from "./labels";
import { hasPublicGraphTracks } from "./hub-counts";
import { catalogueTrackDurationWhere } from "../../db/public-track-visibility";
import { releaseWindowLowerBound } from "./release-day";
import {
  FINDINGS_FROM,
  TRACK_SELECT,
  toPublicTrackListItem,
  toTrackListItem,
  type TrackRow,
} from "./tracks";

type FreshEntityKind = "artist" | "label";

const ENTITY_NARROWING: Record<FreshEntityKind, { join: string; where: string }> = {
  artist: {
    join: "join track_artists on track_artists.track_id = tracks.track_id",
    where: "track_artists.artist_id = ?",
  },
  label: { join: "", where: "tracks.label_id = ?" },
};

function dayString(now: Date, daysAgo: number): string {
  return new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

type FreshEntityCatalogueRow = {
  artists_json: string;
  release_date: string;
  spotify_url: string | null;
  title: string;
  track_id: string;
};

async function listEntityFreshTracks(
  kind: FreshEntityKind,
  entityId: string,
  options?: { limit?: number; now?: Date },
): Promise<FreshTrack[]> {
  const db = await getDb();
  const limit = clampFreshLimit(options?.limit);
  const now = options?.now ?? new Date();

  const windowStart = releaseWindowLowerBound(dayString(now, FRESH_WINDOW_DAYS));
  const today = dayString(now, 0);
  const { join, where } = ENTITY_NARROWING[kind];

  const [findingsResult, catalogueResult] = await Promise.all([
    db.execute({
      args: [entityId, windowStart, today, limit],
      sql: `select ${TRACK_SELECT} from ${FINDINGS_FROM}
            ${join}
            where ${where}
              and tracks.release_date >= ? and tracks.release_date <= ?
            order by tracks.release_date desc, tracks.track_id desc
            limit ?`,
    }),

    db.execute({
      args: [entityId, windowStart, today, limit],
      sql: `select tracks.track_id, tracks.title, tracks.artists_json,
                   tracks.spotify_url, tracks.release_date
            from tracks
            left join findings on findings.track_id = tracks.track_id
            ${join}
            where findings.track_id is null
              and ${catalogueTrackDurationWhere("tracks")}
              and ${where}
              and tracks.release_date >= ? and tracks.release_date <= ?
            order by tracks.release_date desc, tracks.track_id desc
            limit ?`,
    }),
  ]);

  const findings: FreshTrack[] = typedRows<TrackRow>(findingsResult.rows).map((row) => {
    const finding = toPublicTrackListItem(toTrackListItem(row));
    return {
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
    };
  });
  const catalogue: FreshTrack[] = typedRows<FreshEntityCatalogueRow>(catalogueResult.rows).map(
    (row) => ({
      artists: parseArtistsJson(row.artists_json),
      certified: false,
      releaseDate: row.release_date,
      spotifyUrl: row.spotify_url ?? undefined,
      title: row.title,
    }),
  );

  return [...findings, ...catalogue]
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
}

export type EntityFreshFeed = {
  name: string;
  tracks: FreshTrack[];
};

export async function listArtistFreshTracks(
  slug: string,
  options?: { limit?: number; now?: Date },
): Promise<EntityFreshFeed | undefined> {
  const artist = await getPublicArtistBySlug(slug);
  if (!artist) {
    return undefined;
  }
  return { name: artist.name, tracks: await listEntityFreshTracks("artist", artist.id, options) };
}

export async function listLabelFreshTracks(
  slug: string,
  options?: { limit?: number; now?: Date },
): Promise<EntityFreshFeed | undefined> {
  const label = await getLabelBySlug(slug);
  if (!label || !(await hasPublicGraphTracks("labels", label.id))) {
    return undefined;
  }
  return { name: label.name, tracks: await listEntityFreshTracks("label", label.id, options) };
}
