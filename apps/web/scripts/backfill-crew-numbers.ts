#!/usr/bin/env bun
/**
 * The crew-number backfill — a ONE-TIME, operator-run, idempotent pass that stamps a
 * crew number (the account-redesign brief, ruling #1) on every EXISTING account that
 * predates the field. New accounts get theirs at sign-up (the `user.create.after` hook
 * in public-auth.ts); this closes the gap for everyone who enlisted before it shipped.
 *
 * ORDER IS THE MANIFEST. Users are numbered in `created_at ASC` (ties broken by `id`),
 * so the crew's founding order is preserved: the earliest account becomes №1.
 *
 * IDEMPOTENT. It touches only rows whose `crew_number IS NULL`, assigning each
 * `max(crew_number) + 1` via the SAME atomic `assignCrewNumber` the sign-up hook uses.
 * A second run finds no NULL rows and changes nothing; a re-run after new sign-ups
 * leaves the stamped rows alone and numbers only the stragglers.
 *
 * DELIBERATELY NOT wired into the deploy path (unlike the label/graph backfills): the
 * repo just removed slow backfills from `deploy:cf`. The operator runs it ONCE, by
 * hand, after this ships:
 *
 *   bun run --cwd apps/web scripts/backfill-crew-numbers.ts
 *
 * Reads `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` from the environment (locally from
 * apps/web/.dev.vars), exactly like `db:migrate`.
 */
import { type Client, createClient } from "@libsql/client";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assignCrewNumber } from "../src/lib/server/public-auth";

export type CrewBackfillResult = {
  /** How many previously-unstamped accounts this run numbered. */
  assigned: number;
  /** How many accounts already carried a number when the run began (left untouched). */
  skipped: number;
};

/**
 * The idempotent core, taking any libSQL client so a test can drive it against an
 * in-memory DB with the real migrations applied (the `backfillLabels` precedent).
 */
export async function backfillCrewNumbers(client: Client): Promise<CrewBackfillResult> {
  const already = await client.execute({
    sql: `select count(*) as n from "user" where crew_number is not null`,
  });
  const skipped = Number(already.rows[0]?.n ?? 0);

  // Oldest first: the founding order becomes the manifest order. `id` breaks any
  // created_at tie so the numbering is deterministic across runs.
  const pending = await client.execute({
    sql: `select id from "user" where crew_number is null order by created_at asc, id asc`,
  });

  let assigned = 0;

  for (const row of pending.rows) {
    const id = row.id;

    if (typeof id !== "string") {
      continue;
    }

    // Sequential by construction: each call reads the running MAX and adds one, so
    // iterating oldest-first yields 1, 2, 3, … in join order.
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
  const client = createClient(authToken ? { authToken, url } : { url });
  const result = await backfillCrewNumbers(client);

  console.log(
    `crew-number backfill: ${result.assigned} assigned · ${result.skipped} already stamped.`,
  );
}

if (import.meta.main) {
  await main();
}
