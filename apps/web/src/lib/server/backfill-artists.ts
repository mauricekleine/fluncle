// Artist-entity backfill: for existing tracks that predate the artists/track_artists
// tables, re-fetch `/tracks/{trackId}` from Spotify (the cheapest call — one GET
// per finding, no extra enrichment) and upsert `artists` + `track_artists`. The
// Spotify artist IDs are on that response and were previously discarded at ingest.
//
// Mirrors the Discogs / Last.fm backfill model:
//   - One bounded pass per request (MAX_BATCH findings), cursor-resumable.
//   - Skips findings already done (`track_artists` row exists for the trackId)
//     to make the sweep idempotent.
//   - Rate-paced: Spotify's burst limit is generous (the `fetchTrackMetadata`
//     call is already how publish works), so a 300ms inter-request pause is
//     enough to stay comfortable.
//
// The box's `fluncle-artist-backfill` cron drives it via the CLI with its agent
// token; the Worker holds the Spotify credentials and does the actual fetches.

import { upsertTrackArtists } from "./artists";
import { getDb, typedRows } from "./db";
import { fetchTrackMetadata } from "./spotify";

// Comfortable inter-request delay to stay below Spotify's burst ceiling across
// a long backfill run. One fetch per finding; Spotify allows ~180 req/30s, so
// 300ms gives plenty of headroom even at full batch throughput.
const SPOTIFY_DELAY_MS = 300;

// Per-pass cap on eligible findings (those with no track_artists row). Keep this
// small so one pass stays inside the Worker execution budget even when every
// finding needs a full Spotify re-fetch (~300ms each).
const MAX_BATCH = 10;

// The cursor is the track_id of the last finding visited on the prior pass —
// the same opaque-string convention the Discogs / Last.fm backfills use.

type BackfillRow = {
  track_id: string;
  log_id: string | null;
};

export type ArtistsBackfillResult = {
  dryRun: boolean;
  nextCursor: string | null;
  ok: boolean;
  upserted: string[];
  upsertedCount: number;
  skipped: string[];
  skippedCount: number;
  failed: Array<{ logId: string; error: string }>;
  failedCount: number;
};

export async function backfillArtists(
  limit: number,
  dryRun: boolean,
  cursor?: string,
): Promise<ArtistsBackfillResult> {
  const db = await getDb();
  const batchLimit = Math.min(limit, MAX_BATCH);

  // Fetch the next page of findings that have NO track_artists row yet. The
  // LEFT JOIN + IS NULL pattern is the "missing" filter; the cursor pages by
  // track_id (text-comparable, stable across passes).
  const rows = typedRows<BackfillRow>(
    (
      await db.execute({
        args: cursor ? [cursor, batchLimit] : [batchLimit],
        sql: cursor
          ? `select t.track_id, t.log_id
             from tracks t
             left join track_artists ta on ta.track_id = t.track_id
             where ta.track_id is null
               and t.track_id > ?
             order by t.track_id asc
             limit ?`
          : `select t.track_id, t.log_id
             from tracks t
             left join track_artists ta on ta.track_id = t.track_id
             where ta.track_id is null
             order by t.track_id asc
             limit ?`,
      })
    ).rows,
  );

  const upserted: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ logId: string; error: string }> = [];

  let lastTrackId: string | undefined;

  for (const row of rows) {
    lastTrackId = row.track_id;
    const logId = row.log_id ?? row.track_id;

    if (dryRun) {
      upserted.push(logId);
      continue;
    }

    try {
      const metadata = await fetchTrackMetadata(row.track_id);
      await upsertTrackArtists(row.track_id, metadata.artists, metadata.spotifyArtistIds);
      upserted.push(logId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ error: message, logId });
    }

    // Pace requests to stay within Spotify's rate limit.
    await new Promise<void>((resolve) => setTimeout(resolve, SPOTIFY_DELAY_MS));
  }

  // Next cursor: the last track_id visited, or null if we exhausted the queue.
  const nextCursor = rows.length === batchLimit ? (lastTrackId ?? null) : null;

  return {
    dryRun,
    failed,
    failedCount: failed.length,
    nextCursor,
    ok: true,
    skipped,
    skippedCount: skipped.length,
    upserted,
    upsertedCount: upserted.length,
  };
}
