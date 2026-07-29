// Real-libSQL integration harness for the SECOND database (`fluncle-telemetry`) — the
// sibling of `./integration-db.ts`, pointed at `apps/web/drizzle-telemetry` instead of
// `apps/web/drizzle`.
//
// It exists so a test executes the ledger's REAL SQL against the REAL generated
// telemetry migrations. A slice adding SQL against a new table without one is exactly
// how a wrong-table read has reached production here before — and this table is written
// by a raw parameterized insert whose column list must line up with DDL nothing else in
// the suite touches.
//
// Deliberately SEPARATE from `createIntegrationDb`, and deliberately NOT a `*.test.ts`
// (vitest's `include` would otherwise pick it up as a suite). Keeping the two harnesses
// apart mirrors the production boundary: the two schemas never share a migrations
// folder, so a telemetry migration can never touch the primary — and neither can a
// telemetry test.

import { type Client, createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "node:url";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle-telemetry", import.meta.url));

/**
 * A fresh in-memory libSQL database with every generated TELEMETRY migration applied.
 * Each call is an isolated `:memory:` database, so a test can rebuild it per case.
 *
 * The primary harness caches the end-state DDL because replaying 131 migrations per test
 * cost ~102 s across the suite. This folder holds one migration, so the chain is already
 * the cheap path and the cache would be complexity bought for nothing.
 */
export async function createTelemetryIntegrationDb(): Promise<Client> {
  const client = createClient({ url: ":memory:" });

  await migrate(drizzle(client), { migrationsFolder });

  return client;
}
