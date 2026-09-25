import { upsertTrackArtists } from "./artists";
import { getDb, typedRows } from "./db";
import { fetchTrackMetadata } from "./spotify";

const SPOTIFY_DELAY_MS = 300;

const MAX_BATCH = 10;

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

  const rows = typedRows<BackfillRow>(
    (
      await db.execute({
        args: cursor ? [cursor, batchLimit] : [batchLimit],
        sql: cursor
          ? `select t.track_id, t.log_id
             from (findings join tracks on tracks.track_id = findings.track_id) t
             left join track_artists ta on ta.track_id = t.track_id
             where ta.track_id is null
               and t.track_id > ?
             order by t.track_id asc
             limit ?`
          : `select t.track_id, t.log_id
             from (findings join tracks on tracks.track_id = findings.track_id) t
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

    await new Promise<void>((resolve) => setTimeout(resolve, SPOTIFY_DELAY_MS));
  }

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
