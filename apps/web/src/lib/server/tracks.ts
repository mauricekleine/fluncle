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
  durationMs: number;
  isrc?: string;
  label?: string;
  logId?: string;
  note?: string;
  popularity?: number;
  postedToTelegram: boolean;
  previewUrl?: string;
  spotifyUrl: string;
  tags?: string[];
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
  duration_ms: number;
  isrc: string | null;
  label: string | null;
  log_id: string | null;
  note: string | null;
  popularity: number | null;
  preview_url: string | null;
  spotify_url: string;
  tags_json: string | null;
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
  since,
  until,
}: {
  cursor?: TrackCursor;
  limit: number;
  since?: string;
  until?: string;
}): Promise<TrackListPage> {
  const db = await getDb();

  // Discovery-window filters; totalCount is scoped to the same window so a
  // windowed caller (the newsletter agent) gets the matching count, while the
  // homepage's unwindowed calls keep the global archive count for numbering.
  const windowClauses: string[] = [];
  const windowArgs: string[] = [];

  if (since) {
    windowClauses.push("added_at >= ?");
    windowArgs.push(since);
  }

  if (until) {
    windowClauses.push("added_at < ?");
    windowArgs.push(until);
  }

  if (cursor) {
    windowClauses.push("(added_at < ? or (added_at = ? and track_id < ?))");
  }

  const where = windowClauses.length > 0 ? `where ${windowClauses.join(" and ")}` : "";
  const cursorArgs = cursor ? [cursor.addedAt, cursor.addedAt, cursor.trackId] : [];
  const args: Array<string | number> = [...windowArgs, ...cursorArgs, limit + 1];

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
              duration_ms,
              isrc,
              label,
              log_id,
              popularity,
              preview_url,
              tags_json,
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
      args: windowArgs,
      sql: `select count(*) as total_count from tracks ${
        windowArgs.length > 0
          ? `where ${windowClauses.slice(0, windowArgs.length).join(" and ")}`
          : ""
      }`,
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
      durationMs: row.duration_ms,
      isrc: row.isrc ?? undefined,
      label: row.label ?? undefined,
      logId: row.log_id ?? undefined,
      note: row.note?.trim() ? row.note : undefined,
      popularity: row.popularity ?? undefined,
      postedToTelegram: Boolean(row.posted_to_telegram),
      previewUrl: row.preview_url ?? undefined,
      spotifyUrl: row.spotify_url,
      tags: parseTags(row.tags_json),
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

function parseTags(value: string | null): string[] | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const tags = JSON.parse(value) as unknown;

    if (Array.isArray(tags)) {
      const strings = tags.filter((tag): tag is string => typeof tag === "string");

      return strings.length > 0 ? strings : undefined;
    }
  } catch {
    return undefined;
  }

  return undefined;
}
