#!/usr/bin/env bun
/**
 * Resume the registered due-work projection rebuilds against the configured local database.
 *
 * Importing this module does nothing; direct invocation also refuses every remote database URL
 * before opening the normal application client.
 */
import { getDb } from "../src/lib/server/db";
import {
  runDueWorkRebuildToCompletion,
  type DueWorkClient,
  type DueWorkRebuildDefinition,
  type DueWorkRebuildSource,
} from "../src/lib/server/due-work";
import { DUE_WORK_BACKFILLS } from "../src/lib/server/due-work-registry";
import { loadLocalEnv, readEnv } from "../src/lib/server/env";

export type RegisteredDueWorkDefinition = DueWorkRebuildDefinition<string, DueWorkRebuildSource>;
export { DUE_WORK_BACKFILLS };

export async function backfillDueWork(
  client: DueWorkClient,
  definitions: readonly RegisteredDueWorkDefinition[] = DUE_WORK_BACKFILLS,
  options: { limit?: number; newGeneration?: boolean } = {},
): Promise<{ completed: number; projected: number; scanned: number }> {
  let completed = 0;
  let projected = 0;
  let scanned = 0;

  for (const definition of definitions) {
    const checkpoint = await runDueWorkRebuildToCompletion(client, definition, options);
    completed += checkpoint.state === "complete" ? 1 : 0;
    projected += checkpoint.projectedCount;
    scanned += checkpoint.scannedCount;
  }

  return { completed, projected, scanned };
}

export function isLocalDueWorkDatabaseUrl(url: string): boolean {
  return (
    url === ":memory:" ||
    url.startsWith("file:") ||
    /^http:\/\/(127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/.test(url)
  );
}

async function main(): Promise<void> {
  await loadLocalEnv({ force: true });
  const url = await readEnv("TURSO_DATABASE_URL");
  if (!isLocalDueWorkDatabaseUrl(url)) {
    throw new Error("due-work backfill only accepts a configured local database URL");
  }

  const client = await getDb();
  try {
    const result = await backfillDueWork(client, DUE_WORK_BACKFILLS, {
      newGeneration: process.argv.includes("--new-generation"),
    });
    console.log(
      `due-work backfill: ${result.completed} definition(s), ${result.scanned} source row(s), ${result.projected} projected row(s).`,
    );
  } finally {
    client.close();
  }
}

if (import.meta.main) {
  await main();
}
