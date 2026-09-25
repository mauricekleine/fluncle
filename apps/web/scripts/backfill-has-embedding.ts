#!/usr/bin/env bun

import { type Client, createClient } from "@libsql/client";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
  markDueWorkSourceMaintenanceFromSelectStatements,
  markDueWorkSourceMaintenanceStatements,
} from "../src/lib/server/due-work";
import { MIXABLE_ARTISTS_PROJECTION_STATE_KEY } from "../src/lib/server/mixable-artists-projection";

export type HasEmbeddingBackfillResult = {
  flipped: number;
};

const HAS_VECTOR = `exists (select 1 from track_embeddings te where te.track_id = tracks.track_id)`;

export async function backfillHasEmbedding(client: Client): Promise<HasEmbeddingBackfillResult> {
  const sourceMarkers = markDueWorkSourceMaintenanceFromSelectStatements(
    "track",
    {
      sql: `select track_id as subject_id from tracks
            where has_embedding <> ${HAS_VECTOR}`,
    },
    { producer: "backfill-has-embedding-subjects" },
  );
  const results = await client.batch(
    [
      ...sourceMarkers,
      {
        sql: `update tracks set has_embedding = ${HAS_VECTOR}
              where has_embedding <> ${HAS_VECTOR}`,
      },
      {
        args: [MIXABLE_ARTISTS_PROJECTION_STATE_KEY, "dirty:has-embedding"],
        sql: `insert into settings (key, value)
              select ?, ? where changes() > 0
              on conflict(key) do update set value = excluded.value`,
      },
      ...markDueWorkSourceMaintenanceStatements(
        [{ subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID, subjectType: "track" }],
        {
          onlyIfPreviousStatementChanged: true,
          producer: "backfill-has-embedding-rank-corpus",
        },
      ),
    ],
    "write",
  );

  return { flipped: results[sourceMarkers.length]?.rowsAffected ?? 0 };
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
