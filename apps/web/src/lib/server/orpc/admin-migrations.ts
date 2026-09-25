import { env } from "cloudflare:workers";
import { getDb } from "../db";
import { type MigrationMode, migratePreviewArchive } from "../preview-bucket-migration";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { apiFault, type Implementer, parseBool, parseLimit } from "./_shared";

const MIGRATE_DEFAULT_LIMIT = 50;
const MIGRATE_MAX_LIMIT = 500;

function parseMode(value: string | undefined): MigrationMode {
  if (value === "delete" || value === "verify") {
    return value;
  }

  return "copy";
}

export function adminMigrationsHandlers(os: Implementer) {
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
