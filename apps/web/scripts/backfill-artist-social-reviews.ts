#!/usr/bin/env bun

import { type Client, createClient } from "@libsql/client";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type ArtistSocialReviewsBackfillResult = {
  stamped: number;
};

export async function backfillArtistSocialReviews(
  client: Client,
): Promise<ArtistSocialReviewsBackfillResult> {
  const result = await client.execute({
    sql: `update artist_socials
          set reviewed_at = (
            select a.reviewed_at from artists a where a.id = artist_socials.artist_id
          )
          where reviewed_at is null
            and exists (
              select 1 from artists a
              where a.id = artist_socials.artist_id
                and a.reviewed_at is not null
                and artist_socials.created_at <= a.reviewed_at
            )`,
  });

  return { stamped: result.rowsAffected };
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
  const result = await backfillArtistSocialReviews(client);

  console.log(`artist social reviews backfill: ${result.stamped} stamped.`);
}

if (import.meta.main) {
  await main();
}
