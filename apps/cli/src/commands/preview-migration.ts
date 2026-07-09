import { adminApiPost } from "../api";

// REF-05 — the thin HTTP client for the operator-tier preview-bucket migration op
// (`migrate_preview_archive`, POST /api/admin/migrations/preview-archive). The
// Worker owns the R2 bindings + the whole copy/verify/delete state machine; this
// just carries the query params and returns the envelope. Dry-run by default: the
// caller must pass `dryRun: false` to actually copy or delete.

export type PreviewMigrationMode = "copy" | "delete" | "verify";

export type PreviewMigrationResult = {
  // Non-null when the phase REFUSED (e.g. the delete sweep with legacy rows still
  // uncopied); the reason string. When set, nothing was listed or mutated.
  blocked: string | null;
  copied: Array<{ logId: string; newKey: string; oldKey: string; trackId: string }>;
  copiedCount: number;
  deleted: Array<{ oldKey: string; trackId: string }>;
  deletedCount: number;
  dryRun: boolean;
  failed: Array<{ error: string; trackId: string }>;
  failedCount: number;
  mode: PreviewMigrationMode;
  // The resume cursor (DB track_id for copy, R2 list cursor for delete), or null
  // when this phase's set is drained. Always null for verify.
  nextCursor: string | null;
  ok: boolean;
  // copy: legacy rows still to copy. delete/verify: authoritative count of objects
  // still under `analysis/previews/` (from the R2 LIST).
  remaining: number;
  // verify: a sample of the keys still under the prefix (the operator's proof).
  sampleKeys: string[];
  skipped: Array<{ reason: string; trackId: string }>;
  skippedCount: number;
};

// One bounded pass of the migration. `mode` selects the phase ("copy" → private by
// default; "delete" the public-prefix sweep; "verify" the read-only count). Pass the
// prior pass's `nextCursor` to resume; the CLI loops until it comes back null.
export async function migratePreviewArchiveCommand(args: {
  cursor?: string;
  dryRun: boolean;
  limit: number;
  mode: PreviewMigrationMode;
}): Promise<PreviewMigrationResult> {
  const params = new URLSearchParams({
    dryRun: String(args.dryRun),
    limit: String(args.limit),
    mode: args.mode,
  });

  if (args.cursor) {
    params.set("cursor", args.cursor);
  }

  return adminApiPost<PreviewMigrationResult>(
    `/api/admin/migrations/preview-archive?${params.toString()}`,
  );
}
