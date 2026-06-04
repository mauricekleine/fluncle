import { createFileRoute } from "@tanstack/react-router";
import { getDb } from "../../../lib/server/db";

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

export const Route = createFileRoute("/api/tracks/random")({
  server: {
    handlers: {
      GET: async () => {
        const db = await getDb();
        const result = await db.execute({
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
            order by random()
            limit 1`,
        });
        const row = result.rows[0] as unknown as TrackRow | undefined;

        if (!row) {
          return Response.json(
            {
              code: "track_not_found",
              message: "No tracks found",
              ok: false,
            },
            { status: 404 },
          );
        }

        return Response.json({
          ok: true,
          track: {
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
          },
        });
      },
    },
  },
});

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
