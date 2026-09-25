#!/usr/bin/env bun

import { type Client, createClient } from "@libsql/client";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assignCrewNumber } from "../src/lib/server/public-auth";

export type CrewBackfillResult = {
  assigned: number;

  skipped: number;
};

export async function backfillCrewNumbers(client: Client): Promise<CrewBackfillResult> {
  const already = await client.execute({
    sql: `select count(*) as n from "user" where crew_number is not null`,
  });
  const skipped = Number(already.rows[0]?.n ?? 0);

  const pending = await client.execute({
    sql: `select id from "user" where crew_number is null order by created_at asc, id asc`,
  });

  let assigned = 0;

  for (const row of pending.rows) {
    const id = row.id;

    if (typeof id !== "string") {
      continue;
    }

    const number = await assignCrewNumber(id, client);

    if (number !== undefined) {
      assigned += 1;
    }
  }

  return { assigned, skipped };
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
  const result = await backfillCrewNumbers(client);

  console.log(
    `crew-number backfill: ${result.assigned} assigned · ${result.skipped} already stamped.`,
  );
}

if (import.meta.main) {
  await main();
}
