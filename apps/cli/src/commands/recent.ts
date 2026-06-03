import { db } from "../db/client";

type RecentRow = {
  track_id: string;
  spotify_url: string;
  title: string;
  artists_json: string;
  album: string | null;
  album_image_url: string | null;
  note: string | null;
  added_at: string;
  added_to_spotify: number;
  posted_to_telegram: number;
};

export type RecentTransmission = {
  trackId: string;
  spotifyUrl: string;
  title: string;
  artists: string[];
  album?: string;
  albumImageUrl?: string;
  note?: string;
  addedAt: string;
  addedToSpotify: boolean;
  postedToTelegram: boolean;
};

export async function recentCommand(limit: number): Promise<RecentTransmission[]> {
  const result = await db.execute({
    args: [limit],
    sql: `select
        track_id,
        spotify_url,
        title,
        artists_json,
        album,
        album_image_url,
        note,
        added_at,
        added_to_spotify,
        posted_to_telegram
      from tracks
      order by added_at desc
      limit ?`,
  });

  return result.rows.map((row) => {
    const recentRow = row as unknown as RecentRow;

    return {
      addedAt: recentRow.added_at,
      addedToSpotify: Boolean(recentRow.added_to_spotify),
      album: recentRow.album ?? undefined,
      albumImageUrl: recentRow.album_image_url ?? undefined,
      artists: JSON.parse(recentRow.artists_json) as string[],
      note: recentRow.note ?? undefined,
      postedToTelegram: Boolean(recentRow.posted_to_telegram),
      spotifyUrl: recentRow.spotify_url,
      title: recentRow.title,
      trackId: recentRow.track_id,
    };
  });
}
