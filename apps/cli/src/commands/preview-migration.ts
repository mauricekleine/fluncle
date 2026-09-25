import { adminApiPost } from "../api";

export type PreviewMigrationMode = "copy" | "delete" | "verify";

export type PreviewMigrationResult = {
  blocked: string | null;
  copied: Array<{ logId: string; newKey: string; oldKey: string; trackId: string }>;
  copiedCount: number;
  deleted: Array<{ oldKey: string; trackId: string }>;
  deletedCount: number;
  dryRun: boolean;
  failed: Array<{ error: string; trackId: string }>;
  failedCount: number;
  mode: PreviewMigrationMode;

  nextCursor: string | null;
  ok: boolean;

  remaining: number;

  sampleKeys: string[];
  skipped: Array<{ reason: string; trackId: string }>;
  skippedCount: number;
};

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
    `/api/v1/admin/migrations/preview-archive?${params.toString()}`,
  );
}
