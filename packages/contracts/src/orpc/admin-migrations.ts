// The `admin-migrations` domain contract module — one-off, operator-run data
// migrations exposed as batched, dry-run-by-default oRPC ops. Built on the same
// detailed-query pattern as `./admin-backfills.ts`.
//
//   - `migrate_preview_archive` — operator tier. Move the archived 30s previews off
//     the PUBLIC `fluncle-videos` bucket into the PRIVATE `fluncle-source-audio`
//     bucket (REF-05, the copyright exposure fix). Three modes (`mode`): "copy"
//     (default, public → private), "delete" (the public-prefix sweep — authoritative
//     over the `analysis/previews/` prefix, so it also removes orphaned objects no DB
//     row points at), and "verify" (read-only proof of how many objects remain under
//     the prefix). Dry-run is the DEFAULT for copy/delete; the CLI passes
//     `dryRun=false` to mutate.
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
 * `mode` selects the phase — "copy" (default), "delete" (the public-prefix sweep),
 * or "verify" (read-only). `dryRun` (DEFAULT true) reports without mutating for
 * copy/delete. Returns `{ ok, mode, dryRun, blocked, copied, copiedCount, deleted,
 * deletedCount, skipped, skippedCount, failed, failedCount, sampleKeys, nextCursor,
 * remaining }`. `blocked` is non-null when the phase refused (e.g. a delete sweep
 * with legacy rows still uncopied); `remaining` in delete/verify is the authoritative
 * object count still under `analysis/previews/`; `sampleKeys` is the verify proof.
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
        dryRun: z.string().optional(),
        limit: z.string().optional(),
        // "copy" (default) | "delete" | "verify"; a tolerant string, validated in-handler.
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

/** The `admin-migrations` domain's ops, merged into the root contract by `./index.ts`. */
export const adminMigrationsContract = {
  migrate_preview_archive: migratePreviewArchive,
};
