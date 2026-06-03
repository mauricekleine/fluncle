import { createClient } from "@libsql/client/web";
import { createFileRoute } from "@tanstack/react-router";

const defaultLimit = 16;
const maxLimit = 48;
let didLoadLocalEnv = false;

type Cursor = {
  addedAt: string;
  trackId: string;
};

type TrackRow = {
  added_at: string;
  album_image_url: string | null;
  artists_json: string;
  note: string | null;
  spotify_url: string;
  title: string;
  track_id: string;
};

type TrackCountRow = {
  total_count: number;
};

export const Route = createFileRoute("/api/tracks")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        await loadLocalEnv();

        const url = new URL(request.url);
        const limit = parseLimit(url.searchParams.get("limit"));
        const cursor = parseCursor(url.searchParams.get("cursor"));
        const db = createClient({
          authToken: readEnv("TURSO_AUTH_TOKEN"),
          url: readEnv("TURSO_DATABASE_URL"),
        });
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
              album_image_url,
              artists_json,
              note,
              added_at
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

        return Response.json({
          nextCursor:
            hasMore && lastVisibleRow
              ? encodeCursor({
                  addedAt: lastVisibleRow.added_at,
                  trackId: lastVisibleRow.track_id,
                })
              : undefined,
          totalCount,
          tracks: visibleRows.map((row) => ({
            addedAt: row.added_at,
            albumImageUrl: row.album_image_url ?? undefined,
            artists: parseArtists(row.artists_json),
            note: row.note?.trim() ? row.note : undefined,
            spotifyUrl: row.spotify_url,
            title: row.title,
            trackId: row.track_id,
          })),
        });
      },
    },
  },
});

async function loadLocalEnv(): Promise<void> {
  if (!import.meta.env.DEV || didLoadLocalEnv) {
    return;
  }

  const { config } = await import("dotenv");

  config({ path: ".env.local" });
  config({ path: "../../.env.local" });
  config();

  didLoadLocalEnv = true;
}

function parseLimit(value: string | null): number {
  if (!value) {
    return defaultLimit;
  }

  const limit = Number.parseInt(value, 10);

  if (!Number.isInteger(limit) || limit < 1) {
    return defaultLimit;
  }

  return Math.min(limit, maxLimit);
}

function parseCursor(value: string | null): Cursor | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;

    if (typeof parsed.addedAt === "string" && typeof parsed.trackId === "string") {
      return parsed;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function encodeCursor(cursor: Cursor): string {
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

function readEnv(key: "TURSO_AUTH_TOKEN" | "TURSO_DATABASE_URL"): string {
  const value = process.env[key];

  if (!value) {
    throw new Error(`Missing ${key}`);
  }

  return value;
}
