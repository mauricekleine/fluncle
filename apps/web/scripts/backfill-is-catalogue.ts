#!/usr/bin/env bun

import { type Client, createClient } from "@libsql/client";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { markDueWorkSourceMaintenanceFromSelectStatements } from "../src/lib/server/due-work";

export type IsCatalogueBackfillResult = {
  flipped: number;
};

export async function backfillIsCatalogue(client: Client): Promise<IsCatalogueBackfillResult> {
  const results = await client.batch(
    [
      ...markDueWorkSourceMaintenanceFromSelectStatements(
        "track",
        {
          sql: `select track_id as subject_id from tracks
                where track_id in (select track_id from findings)
                  and is_catalogue = 1`,
        },
        { producer: "backfill-is-catalogue" },
      ),
      {
        sql: `update tracks set is_catalogue = 0
              where track_id in (select track_id from findings)
                and is_catalogue = 1`,
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
  const result = await backfillIsCatalogue(client);

  console.log(`is_catalogue backfill: ${result.flipped} certified row(s) flipped to catalogue=0.`);
}

if (import.meta.main) {
  await main();
}
