import { adminApiPost } from "../api";

export type CoverMastersKind = "album" | "artist";

export type CoverMastersBackfillResult = {
  dryRun: boolean;
  failed: Array<{ error: string; slug: string }>;
  failedCount: number;
  kind: CoverMastersKind;

  nextCursor: string | null;

  none: string[];
  noneCount: number;
  ok: boolean;
  rateLimited: boolean;

  requeued?: string[];
  requeuedCount?: number;
  resolved: string[];
  resolvedCount: number;
};

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
