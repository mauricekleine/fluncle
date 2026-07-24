#!/usr/bin/env bun
/**
 * The `is_catalogue` backfill — an idempotent, deploy-time pass that seeds the maintained catalogue
 * discriminator (docs/db-scale-backlog Wave 2 keystone 1) onto history.
 *
 * WHY IT EXISTS. The migration adds `is_catalogue` with `DEFAULT 1` (born catalogue), so every
 * EXISTING row — findings included — lands at `1`. That is correct for the catalogue rows and wrong
 * for the certified ones: a track with a `findings` row must read `is_catalogue = 0`. This flips
 * exactly those. From deploy time onward the write sites keep new certifies correct on their own
 * (publishTrack inserts the track already `0`; certifyExistingTrack flips it in the mint batch), so
 * the ONLY rows this ever touches are the certified ones that predate the column.
 *
 * THE SHAPE IS PROVEN. `where track_id in (select track_id from findings)` drives from the small
 * `findings` table (an indexed PK probe per certified row), measured 660 ms at 150k hosted — NOT
 * `where exists (…)`, which full-scans `tracks` (~97 s). The `and is_catalogue = 1` residual makes it
 * touch only the rows that still need flipping, so a re-run is a true no-op (no write amplification).
 *
 * IDEMPOTENT + SELF-HEALING. Wired into `db:backfill` (package.json), so it runs on every deploy
 * after `db:migrate`: the first deploy flips the historical certified rows; every deploy after finds
 * none left (the write sites already stamp `0`) and changes nothing — a cheap guard that heals any
 * drift. Reads `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` from the environment (locally from
 * apps/web/.dev.vars), exactly like `db:migrate`.
 */
import { type Client, createClient } from "@libsql/client";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type IsCatalogueBackfillResult = {
  /** How many previously-mis-flagged certified rows this run flipped 1 → 0. */
  flipped: number;
};

/**
 * The idempotent core, taking any libSQL client so a test can drive it against an in-memory DB with
 * the real migrations applied (the `backfillCrewNumbers` precedent).
 */
export async function backfillIsCatalogue(client: Client): Promise<IsCatalogueBackfillResult> {
  const result = await client.execute({
    sql: `update tracks set is_catalogue = 0
          where track_id in (select track_id from findings)
            and is_catalogue = 1`,
  });

  return { flipped: result.rowsAffected };
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
  const client = createClient(authToken ? { authToken, url } : { url });
  const result = await backfillIsCatalogue(client);

  console.log(`is_catalogue backfill: ${result.flipped} certified row(s) flipped to catalogue=0.`);
}

if (import.meta.main) {
  await main();
}
