// Artist-avatar backfill: for existing artists minted before the `image_url` column,
// fetch the largest Spotify profile image and stamp it onto `artists.image_url`.
//
// Mirrors the artist-entity backfill (backfill-artists.ts):
//   - One bounded, cursor-resumable pass per request (MAX_BATCH artists).
//   - Only artists still missing an image AND carrying a Spotify id are eligible
//     (an image already present, or no Spotify key to look up, is skipped — the
//     LEFT of the queue), so the sweep is idempotent and self-draining.
//   - One batched Spotify `/v1/artists` call per pass (≤50 ids), so a whole page
//     of artists costs a single API round-trip.
//
// The create path (`upsertTrackArtists` → `fillMissingArtistImages`) covers every
// artist minted from here on; this backfill catches the ~70 that predate the column.
// The on-box `fluncle-artist-sweep` cron drains it a page per tick; the CLI
// (`fluncle admin backfills artist-images`) loops the cursor for an ad-hoc run.

import { fetchArtistImages } from "./spotify";
import { getDb, typedRows } from "./db";

// One batched Spotify call per pass covers 50 ids, so cap the page there.
const MAX_BATCH = 50;

type BackfillRow = {
  id: string;
  spotify_artist_id: string;
};

export type ArtistImagesBackfillResult = {
  dryRun: boolean;
  failed: Array<{ artistId: string; error: string }>;
  failedCount: number;
  filled: string[];
  filledCount: number;
  nextCursor: string | null;
  ok: boolean;
  skipped: string[];
  skippedCount: number;
};

export async function backfillArtistImages(
  limit: number,
  dryRun: boolean,
  cursor?: string,
): Promise<ArtistImagesBackfillResult> {
  const db = await getDb();
  const batchLimit = Math.min(Math.max(1, limit), MAX_BATCH);

  // The eligible page: artists still missing an image that carry a Spotify id to
  // look up, cursor-paged by id (text-comparable, stable across passes).
  const rows = typedRows<BackfillRow>(
    (
      await db.execute({
        args: cursor ? [cursor, batchLimit] : [batchLimit],
        sql: cursor
          ? `select id, spotify_artist_id from artists
             where image_url is null and spotify_artist_id is not null and id > ?
             order by id asc limit ?`
          : `select id, spotify_artist_id from artists
             where image_url is null and spotify_artist_id is not null
             order by id asc limit ?`,
      })
    ).rows,
  );

  const filled: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ artistId: string; error: string }> = [];
  const lastId = rows.at(-1)?.id;

  if (dryRun) {
    for (const row of rows) {
      filled.push(row.id);
    }
  } else if (rows.length > 0) {
    try {
      const images = await fetchArtistImages(rows.map((row) => row.spotify_artist_id));
      const nowIso = new Date().toISOString();

      for (const row of rows) {
        const url = images.get(row.spotify_artist_id);

        if (!url) {
          // Spotify has no image for this artist — leave the column null (the render
          // falls back to a monogram tile) and count it skipped, not failed.
          skipped.push(row.id);
          continue;
        }

        await db.execute({
          args: [url, nowIso, row.id],
          sql: `update artists set image_url = ?, updated_at = ? where id = ? and image_url is null`,
        });
        filled.push(row.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      for (const row of rows) {
        failed.push({ artistId: row.id, error: message });
      }
    }
  }

  // Drained when the page came back short of the batch cap.
  const nextCursor = rows.length === batchLimit ? (lastId ?? null) : null;

  return {
    dryRun,
    failed,
    failedCount: failed.length,
    filled,
    filledCount: filled.length,
    nextCursor,
    ok: true,
    skipped,
    skippedCount: skipped.length,
  };
}
