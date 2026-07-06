import { adminApiPost } from "../api";

export type ArtistsBackfillResult = {
  dryRun: boolean;
  failed: Array<{ error: string; logId: string }>;
  failedCount: number;
  // The feed cursor to resume from on the next pass, or null when the queue is
  // drained. The endpoint handles only a bounded pass per request (each finding
  // requires a Spotify re-fetch), so the CLI loops this until null.
  nextCursor: string | null;
  ok: boolean;
  skipped: string[];
  skippedCount: number;
  upserted: string[];
  upsertedCount: number;
};

// One bounded pass of the artist-entity backfill via the admin API — the Worker
// re-fetches each eligible finding's Spotify track metadata and upserts `artists`
// + `track_artists`. Findings that already have a `track_artists` row are skipped
// (idempotent). `--dry-run` reports which findings would be upserted without
// touching the DB. Pass the prior pass's `nextCursor` to resume; the CLI loops
// until it comes back null.
export async function backfillArtistsCommand(
  limit: number,
  dryRun: boolean,
  cursor?: string,
): Promise<ArtistsBackfillResult> {
  const params = new URLSearchParams({ dryRun: String(dryRun), limit: String(limit) });

  if (cursor) {
    params.set("cursor", cursor);
  }

  return adminApiPost<ArtistsBackfillResult>(`/api/admin/backfill/artists?${params.toString()}`);
}
