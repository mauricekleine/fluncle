// The `admin-migrations` domain router module — one-off, operator-run data
// migrations. The handler wires the Worker's existing R2 bindings + a libSQL
// client into the dependency-injected migration core (../preview-bucket-migration),
// so the op needs NO R2 credentials: both buckets are already bound on the Worker.
//
//   - `migrate_preview_archive` — operator tier (`adminAuth` + `operatorGuard`): a
//     one-off, destructive-capable data migration (it can delete public objects),
//     so a valid agent token 403s. Dry-run is the DEFAULT — the handler treats an
//     ABSENT `dryRun` as `true`, so a bare call reports without mutating; the
//     caller must send `dryRun=false` explicitly to copy or delete.
//
// The params ride the query string of a bodyless POST (`inputStructure: "detailed"`
// in the contract), read via `input.query.*` and coerced with the same tolerant
// `parseLimit`/`parseBool` the backfill ops use.

import { env } from "cloudflare:workers";
import { getDb } from "../db";
import { type MigrationMode, migratePreviewArchive } from "../preview-bucket-migration";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { apiFault, type Implementer, parseBool, parseLimit } from "./_shared";

const MIGRATE_DEFAULT_LIMIT = 50;
const MIGRATE_MAX_LIMIT = 500;

// A tolerant mode parse: only the two non-default modes are honored; anything else
// (including a typo or an absent value) falls to the SAFE default "copy", so a
// mangled `mode=Delete` can never trigger a destructive sweep by accident.
function parseMode(value: string | undefined): MigrationMode {
  if (value === "delete" || value === "verify") {
    return value;
  }

  return "copy";
}

/**
 * Build the `admin-migrations` domain's handlers. The migration logic lives in the
 * DI core (../preview-bucket-migration); this only wires the bindings + parses the
 * query params + relocates the auth to the procedure middleware.
 */
export function adminMigrationsHandlers(os: Implementer) {
  // POST /admin/migrations/preview-archive — operator tier: it can delete public R2
  // objects, so it never rides the agent token. Dry-run defaults ON.
  const migratePreviewArchiveHandler = os.migrate_preview_archive
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const { query } = input;
        const db = await getDb();
        const result = await migratePreviewArchive({
          cursor: query.cursor ?? undefined,
          db,
          // Dry-run is the DEFAULT: an absent `dryRun` reports without mutating. Only
          // an explicit `dryRun=false` performs the copy/delete.
          dryRun: query.dryRun === undefined ? true : parseBool(query.dryRun),
          limit: parseLimit(query.limit, MIGRATE_DEFAULT_LIMIT, MIGRATE_MAX_LIMIT),
          mode: parseMode(query.mode),
          privateBucket: env.SOURCE_AUDIO,
          publicBucket: env.VIDEOS,
        });

        return {
          blocked: result.blocked,
          copied: result.copied,
          copiedCount: result.copiedCount,
          deleted: result.deleted,
          deletedCount: result.deletedCount,
          dryRun: result.dryRun,
          failed: result.failed,
          failedCount: result.failedCount,
          mode: result.mode,
          nextCursor: result.nextCursor,
          ok: true as const,
          remaining: result.remaining,
          sampleKeys: result.sampleKeys,
          skipped: result.skipped,
          skippedCount: result.skippedCount,
        };
      } catch (error) {
        throw apiFault(error);
      }
    });

  return {
    migrate_preview_archive: migratePreviewArchiveHandler,
  };
}
