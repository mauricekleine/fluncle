import { adminApiPost } from "../api";

export type CoverMastersKind = "album" | "artist";

export type CoverMastersBackfillResult = {
  dryRun: boolean;
  failed: Array<{ error: string; slug: string }>;
  failedCount: number;
  kind: CoverMastersKind;
  // The slug cursor to resume from on the next pass, or null when the worklist is drained. Each
  // pass handles a bounded batch, so the CLI loops until null.
  nextCursor: string | null;
  // Entities with no usable source anywhere — floored to the raw URL, terminal.
  none: string[];
  noneCount: number;
  ok: boolean;
  rateLimited: boolean;
  // Slugs re-queued from terminal `none` → `pending` by `--retry-none` before the pass ran (absent
  // on a normal pass — the field is optional so a non-retry response is untouched).
  requeued?: string[];
  requeuedCount?: number;
  resolved: string[];
  resolvedCount: number;
};

// One bounded pass of the owned-cover-master resolve sweep (RFC U3b) via the admin API — the
// Worker fetches each album's/artist's best cover source (album: Apple template → Cover Art
// Archive → Spotify; artist: Spotify), downscaled to ≤1200 by the requested rendition, and stores
// it once in our own R2. Idempotent + self-draining (a resolved/none entity leaves the worklist).
// `--dry-run` reports the eligible worklist without any fetch or write. Pass the prior pass's
// `nextCursor` to resume; the CLI loops until it comes back null. `retryNone` sends `retry=none`,
// re-queuing a bounded batch of terminal `none` rows to `pending` before the pass runs (the
// operator heal for a cover that went `none` historically but now has a source).
export async function backfillCoverMastersCommand(
  kind: CoverMastersKind,
  limit: number,
  dryRun: boolean,
  cursor?: string,
  retryNone = false,
): Promise<CoverMastersBackfillResult> {
  const params = new URLSearchParams({ dryRun: String(dryRun), kind, limit: String(limit) });

  if (cursor) {
    params.set("cursor", cursor);
  }

  if (retryNone) {
    params.set("retry", "none");
  }

  return adminApiPost<CoverMastersBackfillResult>(
    `/api/v1/admin/backfill/cover-masters?${params.toString()}`,
  );
}
