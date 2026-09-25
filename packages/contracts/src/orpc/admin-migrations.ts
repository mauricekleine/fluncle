import { oc } from "@orpc/contract";
import * as z from "zod";

const CopiedSchema = z
  .object({
    logId: z.string(),
    newKey: z.string(),
    oldKey: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "PreviewMigrationCopied" });

const DeletedSchema = z
  .object({
    oldKey: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "PreviewMigrationDeleted" });

const SkippedSchema = z
  .object({
    reason: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "PreviewMigrationSkipped" });

const FailedSchema = z
  .object({
    error: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "PreviewMigrationFailed" });

export const migratePreviewArchive = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "migratePreviewArchive",
    path: "/admin/migrations/preview-archive",
    summary: "Migrate archived 30s previews from the public bucket to the private one (batched)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      query: z.object({
        cursor: z.string().optional(),
        dryRun: z.string().optional(),
        limit: z.string().optional(),

        mode: z.string().optional(),
      }),
    }),
  )
  .output(
    z.object({
      blocked: z.string().nullable(),
      copied: z.array(CopiedSchema),
      copiedCount: z.number(),
      deleted: z.array(DeletedSchema),
      deletedCount: z.number(),
      dryRun: z.boolean(),
      failed: z.array(FailedSchema),
      failedCount: z.number(),
      mode: z.enum(["copy", "delete", "verify"]),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),
      remaining: z.number(),
      sampleKeys: z.array(z.string()),
      skipped: z.array(SkippedSchema),
      skippedCount: z.number(),
    }),
  );

export const adminMigrationsContract = {
  migrate_preview_archive: migratePreviewArchive,
};
