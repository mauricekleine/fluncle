import { getDb } from "./db";

export type TrackCursor = {
  addedAt: string;
  trackId: string;
};

export type TrackListItem = {
  addedAt: string;
  addedToSpotify: boolean;
  album?: string;
  albumImageUrl?: string;
  artists: string[];
  note?: string;
  postedToTelegram: boolean;
  spotifyUrl: string;
  title: string;
  trackId: string;
};

export type TrackListPage = {
  nextCursor?: string;
  totalCount: number;
  tracks: TrackListItem[];
};

type TrackRow = {
  added_at: string;
  album: string | null;
  album_image_url: string | null;
  artists_json: string;
  note: string | null;
  spotify_url: string;
  title: string;
  track_id: string;
  added_to_spotify: number;
  posted_to_telegram: number;
};

type TrackCountRow = {
  total_count: number;
};

export async function listTracks({
  cursor,
  limit,
}: {
  cursor?: TrackCursor;
  limit: number;
}): Promise<TrackListPage> {
  const db = await getDb();
  const args: Array<string | number> = cursor
    ? [cursor.addedAt, cursor.addedAt, cursor.trackId, limit + 1]
    : [limit + 1];
  const where = cursor ? "where added_at < ? or (added_at = ? and track_id < ?)" : "";

  const [result, countResult] = await Promise.all([
    db.execute({
      args,
      sql: `select
              track_id,
              spotify_url,
              title,
              album,
              album_image_url,
              artists_json,
              note,
              added_at,
              added_to_spotify,
              posted_to_telegram
            from tracks
            ${where}
            order by added_at desc, track_id desc
            limit ?`,
    }),
    db.execute({
      sql: `select count(*) as total_count from tracks`,
    }),
  ]);
  const rows = result.rows as unknown as TrackRow[];
  const countRows = countResult.rows as unknown as TrackCountRow[];
  const visibleRows = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const lastVisibleRow = visibleRows.at(-1);
  const totalCount = Number(countRows[0]?.total_count ?? visibleRows.length);

  return {
    nextCursor:
      hasMore && lastVisibleRow
        ? encodeTrackCursor({
            addedAt: lastVisibleRow.added_at,
            trackId: lastVisibleRow.track_id,
          })
        : undefined,
    totalCount,
    tracks: visibleRows.map((row) => ({
      addedAt: row.added_at,
      addedToSpotify: Boolean(row.added_to_spotify),
      album: row.album ?? undefined,
      albumImageUrl: row.album_image_url ?? undefined,
      artists: parseArtists(row.artists_json),
      note: row.note?.trim() ? row.note : undefined,
      postedToTelegram: Boolean(row.posted_to_telegram),
      spotifyUrl: row.spotify_url,
      title: row.title,
      trackId: row.track_id,
    })),
  };
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

function encodeTrackCursor(cursor: TrackCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function parseArtists(value: string): string[] {
  try {
    const artists = JSON.parse(value) as unknown;

    if (Array.isArray(artists)) {
      return artists.filter((artist): artist is string => typeof artist === "string");
    }
  } catch {
    return [];
  }

  return [];
}
