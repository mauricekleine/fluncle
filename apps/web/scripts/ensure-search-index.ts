#!/usr/bin/env bun

import { createClient } from "@libsql/client";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureSearchIndex,
  ensureSearchIndexSchema,
  reconcileSearchIndex,
} from "../src/db/search-index";

const SEARCH_INDEX_RECONCILE_DEADLINE_MS = 120_000;

type SearchIndexMode = "full" | "reconcile" | "schema";

function searchIndexMode(argv: readonly string[]): SearchIndexMode {
  if (argv.includes("--schema")) {
    return "schema";
  }

  return argv.includes("--reconcile") ? "reconcile" : "full";
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
  const mode = searchIndexMode(process.argv);

  if (mode === "schema") {
    const result = await ensureSearchIndexSchema(client);
    console.log(`search index: schema ensured${result.rebuilt ? " (empty index rebuilt)" : ""}.`);
    return;
  }

  if (mode === "reconcile") {
    try {
      const result = await reconcileSearchIndex(client, {
        countDeadlineMs: SEARCH_INDEX_RECONCILE_DEADLINE_MS,
      });
      console.log(
        `search index: ${result.indexed} tracks indexed${result.rebuilt ? " (rebuilt)" : " (already current)"}.`,
      );
    } catch (error) {
      console.warn(
        `search index: reconcile skipped (${error instanceof Error ? error.message : String(error)}); the next deploy retries it.`,
      );
    }
    process.exit(0);
  }

  const result = await ensureSearchIndex(client);

  console.log(
    `search index: ${result.indexed} tracks indexed${result.rebuilt ? " (rebuilt)" : " (already current)"}.`,
  );
}

if (import.meta.main) {
  await main();
}
