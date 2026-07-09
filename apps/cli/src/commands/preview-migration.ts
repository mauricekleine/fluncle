import { adminApiPost } from "../api";

// REF-05 — the thin HTTP client for the operator-tier preview-bucket migration op
// (`migrate_preview_archive`, POST /api/admin/migrations/preview-archive). The
// Worker owns the R2 bindings + the whole copy/verify/delete state machine; this
// just carries the query params and returns the envelope. Dry-run by default: the
// caller must pass `dryRun: false` to actually copy or delete.

export type PreviewMigrationResult = {
  copied: Array<{ logId: string; newKey: string; oldKey: string; trackId: string }>;
  copiedCount: number;
  deletePublic: boolean;
  deleted: Array<{ oldKey: string; trackId: string }>;
  deletedCount: number;
  dryRun: boolean;
  failed: Array<{ error: string; trackId: string }>;
  failedCount: number;
  // The `track_id` to resume from, or null when this phase's set is drained.
  nextCursor: string | null;
  ok: boolean;
  // Findings still awaiting this phase beyond `nextCursor` (0 when drained).
  remaining: number;
  skipped: Array<{ reason: string; trackId: string }>;
  skippedCount: number;
};

// One bounded pass of the migration. `deletePublic` selects the phase (copy →
// private by default; delete the public object when set). Pass the prior pass's
// `nextCursor` to resume; the CLI loops until it comes back null.
export async function migratePreviewArchiveCommand(args: {
  cursor?: string;
  deletePublic: boolean;
  dryRun: boolean;
  limit: number;
}): Promise<PreviewMigrationResult> {
  const params = new URLSearchParams({
    deletePublic: String(args.deletePublic),
    dryRun: String(args.dryRun),
    limit: String(args.limit),
  });

  if (args.cursor) {
    params.set("cursor", args.cursor);
  }

  return adminApiPost<PreviewMigrationResult>(
    `/api/admin/migrations/preview-archive?${params.toString()}`,
  );
}
