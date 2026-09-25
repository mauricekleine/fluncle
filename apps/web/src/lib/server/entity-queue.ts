import { bestAlbumCoverUrl } from "../media";
import { parseArtistsJson } from "./artist-names";
import { listedArtistWhere } from "./artist-visibility";
import { getDb, typedRows } from "./db";
import { releasedByTodaySql, releaseTodayUtc } from "./release-day";

export type EntityQueueTrack = {
  albumImageUrl?: string;
  artists: string[];
  logId?: string;
  releaseDate?: string;
  spotifyUrl?: string;
  title: string;
  trackId: string;
};

export type EntityQueueKind = "album" | "artist" | "label";

export const ENTITY_QUEUE_LIMIT = 20;

export const ALBUM_QUEUE_SAFETY_LIMIT = 100;

type QueueRow = {
  album_image_key: null | string;
  album_image_state: null | string;
  album_image_updated_at: null | string;
  album_image_url: null | string;
  artists_json: string;
  log_id: null | string;
  release_date: null | string;
  spotify_url: null | string;
  title: string;
  track_id: string;
};

const QUEUE_COLUMNS = `tracks.track_id, tracks.title, tracks.artists_json, tracks.spotify_url,
       tracks.album_image_url, tracks.release_date,
       albums.image_key as album_image_key,
       albums.image_state as album_image_state,
       albums.image_updated_at as album_image_updated_at`;

const PLAYABLE_WHERE = `(nullif(trim(tracks.preview_url), '') is not null
         or nullif(trim(tracks.isrc), '') is not null)
     and ${releasedByTodaySql("tracks.release_date")}
     and tracks.dismissed_at is null and tracks.duplicate_of_track_id is null`;

function toEntityQueueTrack(row: QueueRow): EntityQueueTrack {
  return {
    albumImageUrl: bestAlbumCoverUrl({
      imageKey: row.album_image_key,
      imageState: row.album_image_state,
      imageUpdatedAt: row.album_image_updated_at,
      spotifyUrl: row.album_image_url,
    }),
    artists: parseArtistsJson(row.artists_json),
    logId: row.log_id ?? undefined,
    releaseDate: row.release_date ?? undefined,
    spotifyUrl: row.spotify_url ?? undefined,
    title: row.title,
    trackId: row.track_id,
  };
}

export function entityFindingsStatement(kind: EntityQueueKind, id: string, today: string) {
  const edge =
    kind === "artist" ? "cross join track_artists ta on ta.track_id = tracks.track_id" : "";
  const pointer =
    kind === "artist"
      ? "ta.artist_id = ?"
      : kind === "album"
        ? "tracks.album_id = ?"
        : "tracks.label_id = ?";

  return {
    args: [id, today, ENTITY_QUEUE_LIMIT],
    sql: `select ${QUEUE_COLUMNS}, findings.log_id as log_id
          from findings
          cross join tracks on tracks.track_id = findings.track_id
          ${edge}
          left join albums on albums.id = tracks.album_id
          where ${pointer} and ${PLAYABLE_WHERE}
          order by tracks.release_date is null asc, tracks.release_date desc, tracks.track_id desc
          limit ?`,
  };
}

export function entityNewestStatement(kind: "artist" | "label", id: string, today: string) {
  const source =
    kind === "artist"
      ? "track_artists ta cross join tracks on tracks.track_id = ta.track_id"
      : "tracks";
  const pointer = kind === "artist" ? "ta.artist_id = ?" : "tracks.label_id = ?";

  return {
    args: [id, today, ENTITY_QUEUE_LIMIT],
    sql: `select ${QUEUE_COLUMNS}, null as log_id
          from ${source}
          left join albums on albums.id = tracks.album_id
          where ${pointer} and tracks.is_catalogue = 1 and ${PLAYABLE_WHERE}
          order by tracks.release_date desc, tracks.track_id desc
          limit ?`,
  };
}

export function albumTracklistStatement(id: string, today: string) {
  return {
    args: [id, today, ALBUM_QUEUE_SAFETY_LIMIT],
    sql: `select ${QUEUE_COLUMNS}, findings.log_id as log_id
          from tracks
          left join findings on findings.track_id = tracks.track_id
          left join albums on albums.id = tracks.album_id
          where tracks.album_id = ? and ${PLAYABLE_WHERE}
          order by case when findings.log_id is not null then 0 else 1 end asc,
                   case when findings.log_id is not null then findings.added_at end desc,
                   tracks.release_date is null asc, tracks.release_date desc,
                   tracks.title collate nocase asc, tracks.track_id desc
          limit ?`,
  };
}

export async function listEntityQueue(
  kind: EntityQueueKind,
  slug: string,
  now: Date = new Date(),
): Promise<EntityQueueTrack[] | undefined> {
  const db = await getDb();
  const table = kind === "album" ? "albums" : kind === "artist" ? "artists" : "labels";
  const visibility = kind === "artist" ? ` and ${listedArtistWhere("artists")}` : "";
  const entity = await db.execute({
    args: [slug],
    sql: `select id from ${table} where slug = ?${visibility} limit 1`,
  });
  const id = typedRows<{ id: string }>(entity.rows)[0]?.id;
  if (id === undefined) {
    return undefined;
  }

  const today = releaseTodayUtc(now);

  if (kind === "album") {
    const result = await db.execute(albumTracklistStatement(id, today));

    return typedRows<QueueRow>(result.rows).map(toEntityQueueTrack);
  }

  const [findings, newest] = await db.batch(
    [entityFindingsStatement(kind, id, today), entityNewestStatement(kind, id, today)],
    "read",
  );

  return [...typedRows<QueueRow>(findings?.rows ?? []), ...typedRows<QueueRow>(newest?.rows ?? [])]
    .slice(0, ENTITY_QUEUE_LIMIT)
    .map(toEntityQueueTrack);
}
