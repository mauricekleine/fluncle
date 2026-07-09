// The `admin-migrations` domain contract module — one-off, operator-run data
// migrations exposed as batched, dry-run-by-default oRPC ops. Built on the same
// detailed-query pattern as `./admin-backfills.ts`.
//
//   - `migrate_preview_archive` — operator tier. Move the archived 30s previews off
//     the PUBLIC `fluncle-videos` bucket into the PRIVATE `fluncle-source-audio`
//     bucket (REF-05, the copyright exposure fix). Two explicitly-separate phases:
//     copy (default) and delete-the-public-object (`deletePublic`). Dry-run is the
//     DEFAULT; the CLI must pass `dryRun=false` to actually mutate.
//
// Query-only POST: the params ride the URL, the body is empty. `inputStructure:
// "detailed"` exposes `query` so the params reach the handler (oRPC's compact mode
// would source input from the absent body); the handler parses + clamps them with
// the same tolerant coercion the backfill ops use, so a malformed value degrades
// instead of 400-ing. The OUTPUT stays compact (the body is the envelope directly).

import { oc } from "@orpc/contract";
import * as z from "zod";

/** One copied finding: the public key it moved from and the private key it now has. */
const CopiedSchema = z
  .object({
    logId: z.string(),
    newKey: z.string(),
    oldKey: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "PreviewMigrationCopied" });

/** One deleted public object (its reconstructed old key). */
const DeletedSchema = z
  .object({
    oldKey: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "PreviewMigrationDeleted" });

/** One finding held back this pass, with the reason (e.g. `hash_mismatch`). */
const SkippedSchema = z
  .object({
    reason: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "PreviewMigrationSkipped" });

/** One finding that erred mid-migration (e.g. a failed private read-back). */
const FailedSchema = z
  .object({
    error: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "PreviewMigrationFailed" });

/**
 * `migrate_preview_archive` → `POST /admin/migrations/preview-archive` (operationId
 * `migratePreviewArchive`).
 *
 * Operator tier. One bounded pass of the public → private preview-bucket migration.
 * `deletePublic` selects the phase (copy by default; delete the public object when
 * set); `dryRun` (DEFAULT true) reports without mutating. Returns `{ ok, dryRun,
 * deletePublic, copied, copiedCount, deleted, deletedCount, skipped, skippedCount,
 * failed, failedCount, nextCursor, remaining }`.
 */
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
        deletePublic: z.string().optional(),
        dryRun: z.string().optional(),
        limit: z.string().optional(),
      }),
    }),
  )
  .output(
    z.object({
      copied: z.array(CopiedSchema),
      copiedCount: z.number(),
      deletePublic: z.boolean(),
      deleted: z.array(DeletedSchema),
      deletedCount: z.number(),
      dryRun: z.boolean(),
      failed: z.array(FailedSchema),
      failedCount: z.number(),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),
      remaining: z.number(),
      skipped: z.array(SkippedSchema),
      skippedCount: z.number(),
    }),
  );

/** The `admin-migrations` domain's ops, merged into the root contract by `./index.ts`. */
export const adminMigrationsContract = {
  migrate_preview_archive: migratePreviewArchive,
};
