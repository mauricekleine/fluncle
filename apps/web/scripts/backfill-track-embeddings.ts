#!/usr/bin/env bun

import { type Client, createClient } from "@libsql/client";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CHUNK_SIZE = 500;

export type TrackEmbeddingBackfillResult = {
  copied: number;

  destination: number;

  remaining: number;

  source: number;
};

async function nextIdPage(client: Client, after: string, chunkSize: number): Promise<string[]> {
  const result = await client.execute({
    args: [after, chunkSize],
    sql: `select track_id from tracks
          where embedding_blob is not null and track_id > ?
          order by track_id asc
          limit ?`,
  });

  return result.rows.flatMap((row) => (typeof row.track_id === "string" ? [row.track_id] : []));
}

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

      sql: `insert or ignore into track_embeddings (track_id, embedding_blob)
            select track_id, embedding_blob from tracks
            where track_id in (${placeholders}) and embedding_blob is not null`,
    });

    copied += inserted.rowsAffected;

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
  const client = createClient(
    authToken
      ? { authToken, concurrency: REMOTE_DB_CONCURRENCY, url }
      : { concurrency: REMOTE_DB_CONCURRENCY, url },
  );
  const result = await backfillTrackEmbeddings(client, {
    resumeFrom: resumeIndex >= 0 ? process.argv[resumeIndex + 1] : undefined,
  });

  console.log(
    `track_embeddings backfill: ${result.copied} vector(s) copied; ` +
      `${result.source} legacy, ${result.destination} in the satellite.`,
  );

  if (result.remaining > 0) {
    throw new Error(
      `track_embeddings backfill: ${result.remaining} legacy vector(s) still have no satellite row`,
    );
  }
}

if (import.meta.main) {
  await main();
}
