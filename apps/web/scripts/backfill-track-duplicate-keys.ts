#!/usr/bin/env bun
/**
 * Seed the maintained `track_duplicate_keys` projection after its migration lands.
 *
 * The worklist is the missing-key anti-join, read in PK order and committed in bounded batches.
 * Each batch is durable on its own, so an interrupted run resumes from the first still-missing row;
 * a completed run takes the fast count-equality exit. The final count assertion is the deployment
 * rail: the Worker must never rank against a partially materialized identity corpus.
 */
import { type Client, createClient } from "@libsql/client";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { upsertTrackDuplicateKeyStatement } from "../src/lib/server/track-duplicate-keys";

const DEFAULT_BATCH_SIZE = 250;

type BackfillRow = {
  artists_json: string;
  isrc: null | string;
  title: string;
  track_id: string;
};

type Counts = {
  keys: number;
  tracks: number;
};

export type TrackDuplicateKeysBackfillResult = Counts & {
  backfilled: number;
  skipped: boolean;
};

async function counts(client: Client): Promise<Counts> {
  const result = await client.execute(
    `select (select count(*) from tracks) as tracks,
            (select count(*) from track_duplicate_keys) as keys`,
  );
  const row = result.rows[0];

  return {
    keys: Number(row?.keys ?? 0),
    tracks: Number(row?.tracks ?? 0),
  };
}

/** The idempotent, chunked core; accepts any libSQL client for real-schema integration tests. */
export async function backfillTrackDuplicateKeys(
  client: Client,
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<TrackDuplicateKeysBackfillResult> {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("track_duplicate_keys backfill batch size must be a positive integer");
  }

  const before = await counts(client);

  if (before.tracks === before.keys) {
    return { ...before, backfilled: 0, skipped: true };
  }

  let backfilled = 0;

  while (true) {
    const result = await client.execute({
      args: [batchSize],
      sql: `select tracks.track_id, tracks.title, tracks.artists_json, tracks.isrc
            from tracks
            where not exists (
              select 1 from track_duplicate_keys
              where track_duplicate_keys.track_id = tracks.track_id
            )
            order by tracks.track_id asc
            limit ?`,
    });
    const rows = result.rows as unknown as BackfillRow[];

    if (rows.length === 0) {
      break;
    }

    await client.batch(
      rows.map((row) =>
        upsertTrackDuplicateKeyStatement({
          artistsJson: row.artists_json,
          isrc: row.isrc,
          title: row.title,
          trackId: row.track_id,
        }),
      ),
      "write",
    );
    backfilled += rows.length;
  }

  const after = await counts(client);

  if (after.tracks !== after.keys) {
    throw new Error(
      `track_duplicate_keys backfill incomplete: ${after.keys} key rows for ${after.tracks} tracks`,
    );
  }

  return { ...after, backfilled, skipped: false };
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
  const result = await backfillTrackDuplicateKeys(client);

  console.log(
    `track_duplicate_keys backfill: ${result.backfilled} row(s) materialized; ` +
      `${result.keys}/${result.tracks} present${result.skipped ? " (already complete)" : ""}.`,
  );
}

if (import.meta.main) {
  await main();
}
