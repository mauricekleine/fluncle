#!/usr/bin/env bun
/**
 * THE VECTOR SATELLITE BACKFILL — the DATA MOVE behind the `track_embeddings` split
 * (schema.ts § `trackEmbeddings`). It copies every vector still sitting in the legacy
 * `tracks.embedding_blob` column into the satellite, chunked and resumable, and then VERIFIES
 * that not one was left behind.
 *
 * WHY IT IS A BACKFILL AND NOT A STATEMENT IN THE MIGRATION. It could have ridden migration 0158
 * as one authored `INSERT … SELECT` (the `drizzle/0022` / `drizzle/0068` precedent), and that was
 * rejected on size: 43,314 rows × 4 KB is ~169 MB moving inside a single statement on hosted Turso,
 * during a deploy, with no chunk boundary to resume from if it times out. `deploy:cf` is
 * `db:migrate && db:backfill && wrangler deploy`, so a backfill runs in exactly the same window the
 * migration would have — after the table exists, BEFORE the Worker that reads it ships — while
 * staying resumable and idempotent. That is the same argument `backfill-has-embedding.ts` makes for
 * the mirror it seeds, and this runs immediately ahead of it for the same reason: the mirror
 * reconciles against the satellite, so the satellite has to be full first.
 *
 * THE SHAPE. One walk of `tracks` in primary-key order, a page of ids at a time:
 *
 *   1. `select track_id … where embedding_blob is not null and track_id > ? order by track_id` —
 *      the cursor makes the whole run ONE walk of the table rather than one per chunk, and reading
 *      a blob's null flag touches the record header, never its overflow pages.
 *   2. `insert or ignore … select track_id, embedding_blob from tracks where track_id in (…)` —
 *      primary-key lookups, and the vectors move SERVER-SIDE. No 169 MB ever crosses the wire into
 *      this process, which is the same rule the Worker's read paths live by (embedding.ts).
 *
 * `or ignore` is what makes it idempotent, and it is deliberately the weaker of the two upserts: a
 * satellite row that already exists is the LIVE one (the app writes only there now), so a re-run
 * must never overwrite a fresh vector with the stale legacy copy underneath it.
 *
 * WHY THE CURSOR ALWAYS STARTS AT THE BEGINNING. Resuming from `max(track_id)` in the DESTINATION
 * would be wrong after the first deploy: the app mints satellite rows for new tracks at arbitrary
 * ids, so the destination's maximum says nothing about how far this copy got. The walk is cheap
 * enough to repeat (it is the same full scan `backfill-has-embedding.ts` already pays), and
 * `--resume-from` exists for an operator restarting a long first run by hand.
 *
 * THE VERIFICATION is `remaining === 0` — every legacy vector has a satellite row — rather than
 * "destination count equals source count", which is true only on the FIRST run: from then on the
 * destination legitimately holds more, because every new embedding is written there and nowhere
 * else. Both counts are reported so the deploy log shows the gap and where it came from.
 *
 * THIS SCRIPT DIES WITH THE COLUMN. Once `tracks.embedding_blob` is dropped (the separate one-way
 * migration this split deliberately does not carry), there is nothing left to copy: delete this
 * file and its `db:backfill` entry rather than leaving a pass that scans for a column that is gone.
 *
 * Reads `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` from the environment (locally from
 * apps/web/.dev.vars), exactly like `db:migrate` and its sibling backfills.
 */
import { type Client, createClient } from "@libsql/client";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** How many track ids one round trip carries. Bounds the `in (…)` list, not the vectors. */
const DEFAULT_CHUNK_SIZE = 500;

export type TrackEmbeddingBackfillResult = {
  /** Satellite rows this run created (0 on a settled database). */
  copied: number;
  /** Rows in `track_embeddings` after the run — ≥ `source` once the app has minted its own. */
  destination: number;
  /** Legacy vectors STILL without a satellite row after the run. Anything but 0 is a failure. */
  remaining: number;
  /** Rows still carrying a legacy `tracks.embedding_blob`. */
  source: number;
};

/** The one statement that reads the legacy column's presence — a cursor page of ids. */
async function nextIdPage(client: Client, after: string, chunkSize: number): Promise<string[]> {
  const result = await client.execute({
    args: [after, chunkSize],
    sql: `select track_id from tracks
          where embedding_blob is not null and track_id > ?
          order by track_id asc
          limit ?`,
  });

  // A libSQL cell is a union, so narrow rather than stringify — a non-text `track_id` is not a
  // row this can copy, and coercing one would bind a `[object Object]` into the next statement.
  return result.rows.flatMap((row) => (typeof row.track_id === "string" ? [row.track_id] : []));
}

/**
 * The idempotent core, taking any libSQL client so a test can drive it against an in-memory DB
 * with the real migrations applied (the `backfillHasEmbedding` precedent).
 */
export async function backfillTrackEmbeddings(
  client: Client,
  options: { chunkSize?: number; resumeFrom?: string } = {},
): Promise<TrackEmbeddingBackfillResult> {
  const chunkSize = Math.max(1, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  let cursor = options.resumeFrom ?? "";
  let copied = 0;

  for (;;) {
    const ids = await nextIdPage(client, cursor, chunkSize);

    if (ids.length === 0) {
      break;
    }

    const placeholders = ids.map(() => "?").join(", ");
    const inserted = await client.execute({
      args: ids,
      // The vectors are selected and inserted INSIDE the database — this process never holds one.
      sql: `insert or ignore into track_embeddings (track_id, embedding_blob)
            select track_id, embedding_blob from tracks
            where track_id in (${placeholders}) and embedding_blob is not null`,
    });

    copied += inserted.rowsAffected;
    // The page is ordered, so its last id is the next page's floor. An id can never be revisited,
    // which is what keeps the whole run to a single walk of `tracks`.
    cursor = ids[ids.length - 1] ?? cursor;
  }

  const counts = await client.execute(
    `select
       (select count(*) from tracks where embedding_blob is not null) as source,
       (select count(*) from track_embeddings) as destination,
       (select count(*) from tracks
        where embedding_blob is not null
          and not exists (select 1 from track_embeddings te
                          where te.track_id = tracks.track_id)) as remaining`,
  );
  const row = counts.rows[0];

  return {
    copied,
    destination: Number(row?.destination ?? 0),
    remaining: Number(row?.remaining ?? 0),
    source: Number(row?.source ?? 0),
  };
}

async function main(): Promise<void> {
  if (!process.env.TURSO_DATABASE_URL) {
    config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".dev.vars") });
  }

  const url = process.env.TURSO_DATABASE_URL;

  if (!url) {
    throw new Error("TURSO_DATABASE_URL is required (set it in apps/web/.dev.vars)");
  }

  const resumeIndex = process.argv.indexOf("--resume-from");
  const authToken = process.env.TURSO_AUTH_TOKEN;
  const client = createClient(authToken ? { authToken, url } : { url });
  const result = await backfillTrackEmbeddings(client, {
    resumeFrom: resumeIndex >= 0 ? process.argv[resumeIndex + 1] : undefined,
  });

  console.log(
    `track_embeddings backfill: ${result.copied} vector(s) copied; ` +
      `${result.source} legacy, ${result.destination} in the satellite.`,
  );

  // A LOUD failure, not a warning. The Worker ships after this step and reads the satellite as the
  // sole source of truth, so a vector left behind is a track that silently stops being
  // recommendable, mixable and searchable-by-sound — with nothing to notice it.
  if (result.remaining > 0) {
    throw new Error(
      `track_embeddings backfill: ${result.remaining} legacy vector(s) still have no satellite row`,
    );
  }
}

if (import.meta.main) {
  await main();
}
