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

export type FollowArtistResult = {
  dryRun: boolean;
  failed: Array<{ error: string; platform: string; socialId: string }>;
  failedCount: number;
  followed: Array<{ artistId: string; artistName: string; platform: string; socialId: string }>;
  followedCount: number;
  ok: boolean;
  // Followable targets still unfollowed after this batch. The CLI loops until it's 0.
  remaining: number;
};

// One bounded pass of the auto-follow sweep (Epic B) via the admin API — the Worker
// follows a batch of high-confidence artists across Spotify + YouTube (status auto/
// confirmed, idempotent by followed_at IS NULL, quota-paced). `--dry-run` reports what
// WOULD be followed without calling the platforms or writing. Loop while `remaining > 0`.
export async function followArtistsCommand(
  limit: number,
  dryRun: boolean,
): Promise<FollowArtistResult> {
  const params = new URLSearchParams({ dryRun: String(dryRun), limit: String(limit) });

  return adminApiPost<FollowArtistResult>(`/api/admin/artists/follow?${params.toString()}`);
}
