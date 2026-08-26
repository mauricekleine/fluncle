#!/usr/bin/env bun
/**
 * The `has_embedding` backfill — an idempotent, deploy-time pass that reconciles the maintained
 * embedding-presence mirror (docs/db-scale-backlog Wave 2 #4) against the vectors themselves.
 *
 * WHAT IT MIRRORS. `has_embedding` is `1` iff a `track_embeddings` row exists (schema.ts §
 * `trackEmbeddings`), so this reconciles against the SATELLITE — not against the legacy
 * `tracks.embedding_blob` column it used to read, which is now unread and awaiting its drop. It
 * runs immediately AFTER `backfill-track-embeddings.ts` in `db:backfill` for that reason: the
 * satellite must hold the moved history before the flag is derived from it, or this pass would
 * cheerfully zero every mirror on the deploy that lands the split.
 *
 * WHY IT EXISTS AT ALL. The migration that added `has_embedding` gave it `DEFAULT 0`, so every
 * EXISTING row landed un-embedded — correct for the rows with no vector and WRONG for every row
 * that already carried one (21,088 of 54,860 on prod at the time of writing). Until it runs,
 * `/admin/funnel` under-reports `embedded` and `rec_eligible`, and — now that the mirror is what
 * both partial queue indexes are keyed on — the embed queue would offer up rows that are already
 * embedded. An under-report, never an over-report, and never a wrong RANKING (the vector reads
 * join the satellite itself).
 *
 * DEPLOY ORDER IS WHAT MAKES THAT SAFE. `deploy:cf` is `db:migrate && db:backfill && wrangler
 * deploy` (package.json), so the column is added and flipped BEFORE the Worker that reads it ships.
 * The old Worker in front of a migrated database reads a column it never mentions; the new Worker
 * never sees an unflipped one.
 *
 * THE SHAPE, AND WHY IT CORRECTS BOTH DIRECTIONS. It sets the flag to the satellite's answer
 * wherever the two disagree — not the narrower "flip the un-flagged embedded rows". Seeding
 * history only ever needs 0 → 1, but the failure mode a maintained mirror actually has is drift
 * either way: a hand-run `DELETE FROM track_embeddings` in a console, or a restored backup, leaves
 * a row FLAGGED with no vector, and that direction makes the funnel OVER-report AND hides the row
 * from the re-embed queue. Reconciling against the vectors is the same cost as the one-way form
 * and turns this from a one-shot seed into a standing backstop — the same posture as the
 * hub-counts reconciliation sweep (Wave 2 #2 slice C).
 *
 * It is a full scan of `tracks` either way, and it REWRITES each matching row, so the first run is
 * the expensive one: 108 s over 21,088 embedded rows on a hosted prod-scale clone (measured
 * against the pre-satellite shape), alongside a 63 s build of `tracks_funnel_scan_idx` in the
 * migration ahead of it — call it three minutes added to the ONE deploy that lands them, and
 * nothing on the deploys after. The existence probe is a primary-key lookup into a table an order
 * of magnitude smaller than `tracks`. The `where` residual is what makes the SECOND run cheap: on
 * a correct database it matches nothing, so there is no write amplification on later deploys.
 *
 * IDEMPOTENT + SELF-HEALING. Wired into `db:backfill`, so it runs on every deploy after
 * `db:migrate`: the first deploy seeds history, every deploy after finds nothing to correct (the
 * satellite's one writing module keeps the mirror moving in lockstep — schema.ts §
 * `has_embedding`, and `embedding-mirror.test.ts` fails the build if a second writer appears) and
 * changes nothing. Reads `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` from the environment (locally
 * from apps/web/.dev.vars), exactly like `db:migrate` and its sibling backfills.
 */
import { type Client, createClient } from "@libsql/client";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
  markDueWorkSourceRepairsFromSelectStatement,
  markDueWorkSourceRepairsStatement,
} from "../src/lib/server/due-work";

export type HasEmbeddingBackfillResult = {
  /** How many rows this run reconciled against their vector, in either direction. */
  flipped: number;
};

/** "This track has a vector", as SQL — the fact `has_embedding` mirrors. */
const HAS_VECTOR = `exists (select 1 from track_embeddings te where te.track_id = tracks.track_id)`;

/**
 * The idempotent core, taking any libSQL client so a test can drive it against an in-memory DB with
 * the real migrations applied (the `backfillIsCatalogue` precedent).
 */
export async function backfillHasEmbedding(client: Client): Promise<HasEmbeddingBackfillResult> {
  const [, result] = await client.batch(
    [
      markDueWorkSourceRepairsFromSelectStatement(
        "track",
        {
          sql: `select track_id as subject_id from tracks
                where has_embedding <> ${HAS_VECTOR}`,
        },
        { producer: "backfill-has-embedding-subjects" },
      ),
      {
        sql: `update tracks set has_embedding = ${HAS_VECTOR}
              where has_embedding <> ${HAS_VECTOR}`,
      },
      markDueWorkSourceRepairsStatement(
        [{ subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID, subjectType: "track" }],
        {
          onlyIfPreviousStatementChanged: true,
          producer: "backfill-has-embedding-rank-corpus",
        },
      ),
    ],
    "write",
  );

  return { flipped: result?.rowsAffected ?? 0 };
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
  const result = await backfillHasEmbedding(client);

  console.log(`has_embedding backfill: ${result.flipped} row(s) reconciled against their vector.`);
}

if (import.meta.main) {
  await main();
}
