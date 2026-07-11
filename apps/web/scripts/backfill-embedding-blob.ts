#!/usr/bin/env bun
/**
 * The `embedding_json` → `embedding_blob` backfill — IDEMPOTENT, and FOLDED INTO THE
 * DEPLOY: `deploy:cf` runs it as part of `db:backfill`, after `db:migrate` and BEFORE
 * `wrangler deploy`. That ordering is the zero-downtime guarantee: by the time the new
 * Worker (which ranks against `embedding_blob`) is serving, every embedded finding
 * already has its blob. Re-running is a no-op — the update is guarded on
 * `embedding_blob IS NULL`.
 *
 * WHY: a 1024-d MuQ vector is 21,804 B as a JSON array and 4,096 B as a native libSQL
 * `F32_BLOB(1024)`, and only the blob form can be ranked by the DATABASE
 * (`vector_distance_cos`) instead of by shipping the whole corpus into a 128 MB Worker
 * isolate. See lib/server/embedding.ts and docs/rfcs/turso-scale-spike.md.
 *
 * SAFETY. `vector32()` THROWS on anything it cannot read (malformed JSON, a wrong-width
 * array, an array of strings), and one bad row would abort the whole statement — so the
 * guard admits a row only when its JSON is valid, exactly `EMBEDDING_DIMS` long, and
 * every element a number. A row that fails the guard keeps its JSON, gets no blob, and
 * is simply skipped by the similarity reads — the same silent skip the old in-isolate
 * `parseEmbedding` gave it. (The write path validates before storing, so such a row
 * should not exist; this is the belt.)
 *
 * `embedding_json` REMAINS THE SOURCE OF TRUTH and is not touched. Dropping it is the
 * follow-up, once the blob path has run in production.
 *
 * Chunked by `track_id` so a large archive backfills in bounded statements rather than
 * one enormous write (60 findings today; the loop is what makes it safe at 100k).
 */
import { type Client, createClient } from "@libsql/client";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDING_DIMS } from "../src/lib/server/embedding";

/** Rows converted per statement — bounded so no single write is unbounded at 100k. */
const CHUNK_SIZE = 500;

export type EmbeddingBlobBackfillResult = {
  /** Rows carrying a vector the guard rejected — they keep their JSON and get no blob. */
  malformed: number;
  /** Rows that gained an `embedding_blob` this run. */
  converted: number;
};

/**
 * The idempotent core, taking any libSQL client so the integration test can drive it
 * against an in-memory database with the real migrations applied.
 */
export async function backfillEmbeddingBlob(client: Client): Promise<EmbeddingBlobBackfillResult> {
  // The guard mirrors `embeddingVectorSql`'s JSON arm exactly: valid JSON, the right
  // width, every element numeric. `vector32()` is reached for nothing else.
  const readable = `json_valid(embedding_json)
                    and json_array_length(embedding_json) = ${EMBEDDING_DIMS}
                    and not exists (
                      select 1 from json_each(tracks.embedding_json) je
                      where je.type not in ('integer', 'real')
                    )`;
  const result: EmbeddingBlobBackfillResult = { converted: 0, malformed: 0 };

  for (;;) {
    const chunk = await client.execute({
      args: [CHUNK_SIZE],
      sql: `update tracks set embedding_blob = vector32(embedding_json)
            where track_id in (
              select track_id from tracks
              where embedding_blob is null and embedding_json is not null and ${readable}
              limit ?
            )`,
    });

    result.converted += chunk.rowsAffected;

    if (chunk.rowsAffected === 0) {
      break;
    }
  }

  // Whatever is left with JSON but no blob failed the guard — worth NAMING rather than
  // leaving as a silent hole in the similarity rows.
  const stuck = await client.execute({
    sql: `select count(*) as n from tracks
          where embedding_blob is null and embedding_json is not null`,
  });

  result.malformed = Number(stuck.rows[0]?.n ?? 0);

  return result;
}

async function main(): Promise<void> {
  // The Cloudflare deploy environment provides the Turso env; local runs fall back to
  // `.dev.vars` (the drizzle.config.ts loading — dotenv never overrides a set var).
  if (!process.env.TURSO_DATABASE_URL) {
    config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".dev.vars") });
  }

  const url = process.env.TURSO_DATABASE_URL;

  if (!url) {
    throw new Error("TURSO_DATABASE_URL is required (set it in apps/web/.dev.vars)");
  }

  const authToken = process.env.TURSO_AUTH_TOKEN;
  const client = createClient(authToken ? { authToken, url } : { url });
  const result = await backfillEmbeddingBlob(client);

  console.log(
    `embedding_blob backfill: ${result.converted} vectors converted` +
      (result.malformed > 0
        ? `, ${result.malformed} UNREADABLE (kept their JSON, skipped by the similarity reads).`
        : "."),
  );
}

if (import.meta.main) {
  await main();
}
