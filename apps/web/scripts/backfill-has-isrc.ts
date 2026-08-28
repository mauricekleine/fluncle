#!/usr/bin/env bun
/**
 * The `has_isrc` backfill — an idempotent, deploy-time pass that seeds the maintained
 * ISRC-presence mirror (schema.ts § `has_isrc`) onto history, the `backfill-has-embedding.ts`
 * posture applied to the anchor worklist's leading sort key.
 *
 * WHY IT EXISTS. The migration adds `has_isrc` with `DEFAULT 0`, so every EXISTING row lands
 * ISRC-less — correct for the rows with no ISRC and WRONG for every row that already carries one.
 * Until it runs, the anchor worklist's ISRC-first drain order treats history as unanchorable-first
 * — an ordering under-report, never a wrong answer (the exact-ISRC rung still reads `isrc`
 * itself). `deploy:cf` runs the bounded primary migration, then `db:backfill`, then the required
 * telemetry migration and `wrangler deploy` (package.json), so the column exists before the
 * backfill flips it and before the Worker that sorts on it ships.
 *
 * THE SHAPE RECONCILES BOTH DIRECTIONS against the column itself — `trim()` included, because
 * legacy rows carry empty-string ISRCs that must mirror to 0 — so this is a standing backstop
 * against console edits and restored backups, not a one-shot seed. The `where` residual is what
 * makes every later run free: on a correct database it matches nothing. The write sites keep the
 * pair in lockstep (`isrc-mirror.test.ts` fails the build on a writer that forgets).
 */
import { type Client, createClient } from "@libsql/client";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { markDueWorkSourceMaintenanceFromSelectStatements } from "../src/lib/server/due-work";

export type HasIsrcBackfillResult = {
  /** How many rows this run reconciled against their ISRC, in either direction. */
  flipped: number;
};

/**
 * The idempotent core, taking any libSQL client so a test can drive it against an in-memory DB
 * with the real migrations applied (the `backfillHasEmbedding` precedent).
 */
export async function backfillHasIsrc(client: Client): Promise<HasIsrcBackfillResult> {
  const results = await client.batch(
    [
      ...markDueWorkSourceMaintenanceFromSelectStatements(
        "track",
        {
          sql: `select track_id as subject_id from tracks
                where has_isrc <> (isrc is not null and trim(isrc) <> '')`,
        },
        { producer: "backfill-has-isrc" },
      ),
      {
        sql: `update tracks set has_isrc = (isrc is not null and trim(isrc) <> '')
              where has_isrc <> (isrc is not null and trim(isrc) <> '')`,
      },
    ],
    "write",
  );

  return { flipped: results.at(-1)?.rowsAffected ?? 0 };
}

async function main(): Promise<void> {
  if (!process.env.TURSO_DATABASE_URL) {
    config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".dev.vars") });
  }

  const url = process.env.TURSO_DATABASE_URL;

  if (!url) {
    throw new Error("TURSO_DATABASE_URL is required (set it in apps/web/.dev.vars)");
  }

  const authToken = process.env.TURSO_AUTH_TOKEN;
  const client = createClient(
    authToken
      ? { authToken, concurrency: REMOTE_DB_CONCURRENCY, url }
      : { concurrency: REMOTE_DB_CONCURRENCY, url },
  );
  const result = await backfillHasIsrc(client);

  console.log(`has_isrc backfill: ${result.flipped} row(s) reconciled against their ISRC.`);
}

if (import.meta.main) {
  await main();
}
