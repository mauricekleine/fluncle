#!/usr/bin/env bun

import { type Client, createClient } from "@libsql/client";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { markDueWorkSourceMaintenanceFromSelectStatements } from "../src/lib/server/due-work";

export type IdentityLedgerBackfillResult = {
  discogsStamped: number;

  isrcStamped: number;

  publishAnchorsStamped: number;
};

export async function backfillIdentityLedger(
  client: Client,
  now: string = new Date().toISOString(),
): Promise<IdentityLedgerBackfillResult> {
  const isrcResults = await client.batch(
    [
      ...markDueWorkSourceMaintenanceFromSelectStatements(
        "track",
        {
          sql: `select track_id as subject_id from tracks
                where isrc is not null and trim(isrc) <> '' and isrc_attempted_at is null`,
        },
        { producer: "backfill-identity-isrc-attempt" },
      ),
      {
        args: [now],
        sql: `update tracks
              set isrc_attempted_at = coalesce(
                    (select f.added_at from findings f where f.track_id = tracks.track_id),
                    ?)
              where isrc is not null and trim(isrc) <> '' and isrc_attempted_at is null`,
      },
    ],
    "write",
  );

  const discogsResults = await client.batch(
    [
      ...markDueWorkSourceMaintenanceFromSelectStatements(
        "track",
        {
          sql: `select track_id as subject_id from tracks
                where (in_release_id is not null or in_master_id is not null)
                  and backfill_discogs_attempted_at is null`,
        },
        { producer: "backfill-identity-discogs-attempt" },
      ),
      {
        args: [now, now],
        sql: `update tracks
              set backfill_discogs_attempted_at = coalesce(
                    (select f.added_at from findings f where f.track_id = tracks.track_id),
                    ?),
                  backfill_discogs_done_at = coalesce(
                    (select f.added_at from findings f where f.track_id = tracks.track_id),
                    ?),
                  backfill_discogs_attempts = 1
              where (in_release_id is not null or in_master_id is not null)
                and backfill_discogs_attempted_at is null`,
      },
    ],
    "write",
  );

  const publishAnchors = await client.execute({
    sql: `update tracks
          set spotify_anchor_source = 'publish',
              spotify_anchor_verified_by = 'publish',
              spotify_anchored_at = coalesce(
                spotify_anchored_at,
                (select f.added_at from findings f where f.track_id = tracks.track_id))
          where spotify_anchor_source is null
            and spotify_anchor_verified_by is null
            and spotify_uri = 'spotify:track:' || track_id
            and exists (select 1 from findings f where f.track_id = tracks.track_id)`,
  });

  return {
    discogsStamped: discogsResults.at(-1)?.rowsAffected ?? 0,
    isrcStamped: isrcResults.at(-1)?.rowsAffected ?? 0,
    publishAnchorsStamped: publishAnchors.rowsAffected,
  };
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
  const result = await backfillIdentityLedger(client);

  console.log(
    `identity ledger: ${result.isrcStamped} ISRC attempt stamp(s) · ` +
      `${result.discogsStamped} Discogs attempt record(s) · ` +
      `${result.publishAnchorsStamped} publish anchor provenance stamp(s).`,
  );
}

if (import.meta.main) {
  await main();
}
