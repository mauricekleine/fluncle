import { adminApiPost } from "../api";

export type LabelImagesBackfillResult = {
  dryRun: boolean;
  failed: Array<{ error: string; slug: string }>;
  failedCount: number;
  // The slug cursor to resume from on the next pass, or null when the worklist is drained (or a
  // vendor throttle stopped the pass). Each pass handles a bounded batch, so the CLI loops until
  // null.
  nextCursor: string | null;
  // Labels with no own image anywhere (Discogs + Wikidata both empty) — floored to the cover.
  none: string[];
  noneCount: number;
  ok: boolean;
  rateLimited: boolean;
  resolved: string[];
  resolvedCount: number;
};

// One bounded pass of the label-image resolve sweep via the admin API — the Worker walks each
// label's MusicBrainz identity, reads its curated Discogs/Wikidata url-rels, and downloads its
// logo once into our own R2. Idempotent + self-draining (a resolved/none label leaves the
// worklist). `--dry-run` reports the eligible worklist without any vendor call or write. Pass the
// prior pass's `nextCursor` to resume; the CLI loops until it comes back null.
export async function backfillLabelImagesCommand(
  limit: number,
  dryRun: boolean,
  cursor?: string,
): Promise<LabelImagesBackfillResult> {
  const params = new URLSearchParams({ dryRun: String(dryRun), limit: String(limit) });

  if (cursor) {
    params.set("cursor", cursor);
  }

  return adminApiPost<LabelImagesBackfillResult>(
    `/api/admin/backfill/label-images?${params.toString()}`,
  );
}
