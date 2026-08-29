#!/usr/bin/env bun
/** Apply the generated migration suffix not yet stamped in production. */
import { createClient, type Client, type InStatement } from "@libsql/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";

import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import {
  parseMigrationJournal,
  planPendingProductionMigrations,
  readLastAppliedMigrationWhen,
  type MigrationJournalEntry,
  type ProductionMigrationPlan,
} from "./guard-production-migrations";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const journalUrl = new URL("../drizzle/meta/_journal.json", import.meta.url);

/** Prove Drizzle's file reader and the parsed journal still describe the same ordered chain. */
export function pairJournalWithMigrations(
  entries: readonly MigrationJournalEntry[],
  migrations: readonly MigrationMeta[],
): Array<{ entry: MigrationJournalEntry; migration: MigrationMeta }> {
  if (entries.length !== migrations.length) {
    throw new Error("production migration runner: journal and SQL migration counts differ");
  }

  return entries.map((entry, index) => {
    const migration = migrations[index];
    if (!migration || migration.folderMillis !== entry.when) {
      throw new Error(
        `production migration runner: SQL metadata does not match journal entry ${entry.tag}`,
      );
    }

    return { entry, migration };
  });
}

/** Build the exact atomic libSQL batch for the pending journal entries. */
export function statementsForMigrationPlan(
  pairs: ReadonlyArray<{ entry: MigrationJournalEntry; migration: MigrationMeta }>,
  plan: ProductionMigrationPlan,
): InStatement[] {
  const pendingTags = new Set(plan.pendingEntries.map((entry) => entry.tag));

  for (const pendingEntry of plan.pendingEntries) {
    const pair = pairs.find(({ entry }) => entry.tag === pendingEntry.tag);
    if (!pair || pair.entry.when !== pendingEntry.when) {
      throw new Error(
        `production migration runner: pending entry ${pendingEntry.tag} is absent from the loaded SQL chain`,
      );
    }
  }

  return pairs.flatMap(({ entry, migration }) => {
    if (!pendingTags.has(entry.tag)) {
      return [];
    }
    return [
      ...migration.sql.map((sql) => ({ args: [], sql })),
      {
        args: [migration.hash, migration.folderMillis],
        sql: 'insert into "__drizzle_migrations" ("hash", "created_at") values (?, ?)',
      },
    ];
  });
}

export async function applyProductionMigrationPlan(
  client: Pick<Client, "execute" | "migrate">,
  pairs: ReadonlyArray<{ entry: MigrationJournalEntry; migration: MigrationMeta }>,
  plan: ProductionMigrationPlan,
): Promise<void> {
  if (plan.pendingEntries.length === 0) {
    return;
  }

  await client.execute({
    args: [],
    sql: `create table if not exists "__drizzle_migrations" (
      id SERIAL primary key,
      hash text not null,
      created_at numeric
    )`,
  });

  const statements = statementsForMigrationPlan(pairs, plan);
  if (statements.length === 0) {
    throw new Error("production migration runner: non-empty plan produced no SQL statements");
  }

  await client.migrate(statements);
}

async function main(): Promise<void> {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) {
    throw new Error(
      "production migration runner: TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required",
    );
  }

  const journalJson = readFileSync(journalUrl, "utf8");
  const entries = parseMigrationJournal(journalJson);
  const migrations = readMigrationFiles({ migrationsFolder });
  const pairs = pairJournalWithMigrations(entries, migrations);
  const client = createClient({ authToken, concurrency: REMOTE_DB_CONCURRENCY, url });

  try {
    const plan = await planPendingProductionMigrations({
      journalJson,
      readLastAppliedWhen: () => readLastAppliedMigrationWhen(client),
    });

    await applyProductionMigrationPlan(client, pairs, plan);

    console.warn(
      `PRODUCTION MIGRATION: complete — through ${plan.throughTag ?? "empty journal"}; applied ${plan.pendingEntries.map((entry) => entry.tag).join(",") || "none"}.`,
    );
  } finally {
    client.close();
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "production migration runner failed");
    process.exitCode = 1;
  }
}
