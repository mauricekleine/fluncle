#!/usr/bin/env bun

import { createClient, type Client } from "@libsql/client";
import { labelFold } from "@fluncle/contracts/util/galaxy-slug";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";

const PAGE_SIZE = 100;

export async function backfillLabelNameFolds(
  client: Pick<Client, "batch" | "execute">,
): Promise<number> {
  let updated = 0;
  for (;;) {
    const page = await client.execute({
      args: [PAGE_SIZE],
      sql: `select id, name from labels where name_fold is null order by rowid limit ?`,
    });
    if (page.rows.length === 0) {
      return updated;
    }
    const results = await client.batch(
      page.rows.map((row) => {
        if (typeof row.id !== "string" || typeof row.name !== "string") {
          throw new Error("label fold backfill requires string label identities and names");
        }
        return {
          args: [labelFold(row.name), row.id, row.name],
          sql: `update labels set name_fold = ? where id = ? and name = ? and name_fold is null`,
        };
      }),
      "write",
    );
    updated += results.reduce((sum, result) => sum + result.rowsAffected, 0);
  }
}

async function main(): Promise<void> {
  if (!process.env.TURSO_DATABASE_URL) {
    config({ path: fileURLToPath(new URL("../.dev.vars", import.meta.url)) });
  }
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) {
    throw new Error("TURSO_DATABASE_URL is required");
  }
  const client = createClient({
    authToken: process.env.TURSO_AUTH_TOKEN,
    concurrency: REMOTE_DB_CONCURRENCY,
    url,
  });
  try {
    console.log(`label name folds: ${await backfillLabelNameFolds(client)} rows backfilled.`);
  } finally {
    client.close();
  }
}

if (import.meta.main) {
  await main();
}
