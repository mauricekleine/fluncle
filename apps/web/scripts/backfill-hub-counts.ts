#!/usr/bin/env bun
/**
 * The hub-counts backfill — the one-time seed for the maintained per-entity counters
 * (docs/db-scale-backlog Wave 2 keystone 2), and a deploy-time no-op ever after.
 *
 * WHY IT EXISTS. The migration adds `renderable_track_count` / `certified_finding_count` to
 * `labels`, `albums` and `artists` with `DEFAULT 0`, so every EXISTING row lands at zero while the
 * edges it should be counting already exist. From deploy time onward every write path maintains the
 * pair as deltas (lib/server/hub-counts.ts) — but nothing in history was ever counted. This counts
 * it, once.
 *
 * THE SHAPE. One single-pass grouped `UPDATE … FROM (SELECT … GROUP BY fk)` per table — three
 * statements for the whole archive, not a per-entity loop. `certified` rides
 * `tracks.is_catalogue = 0` (keystone 1's materialized discriminator), never a `findings` join. The
 * artists pass groups over `track_artists ⋈ tracks`, the ~2×-tracks edge table. An entity with zero
 * linked tracks appears in no group and keeps its DDL default of 0 — correct by construction.
 *
 * WHY THE GUARD, AND WHY IT IS NOT OPTIONAL. `db:backfill` runs on EVERY deploy, and this is the
 * one recompute-from-truth in the whole design — the exact shape the write paths are forbidden to
 * use, because at 150k hosted it measured 27,400 ms against ~200 ms for delta arithmetic. Paying
 * that on every deploy would be absurd, and re-running it over live counters would also silently
 * paper over a real maintenance bug (the drift a future reconciliation sweep is meant to REPORT).
 * So: if any `labels` row already carries a non-zero renderable count, this is a no-op. `--force`
 * runs it anyway — the operator's escape hatch after an out-of-band bulk edge write (e.g.
 * `scripts/backfill-artist-links.ts`, the whole-corpus artist-link reconciler, or a prune that
 * deleted tracks straight out of the database).
 *
 * Reads `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` from the environment (locally from
 * apps/web/.dev.vars), exactly like `db:migrate`.
 */
import { type Client, createClient } from "@libsql/client";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type HubCountsBackfillResult = {
  /** Rows written per entity table. Absent when the run was skipped. */
  filled?: { albums: number; artists: number; labels: number };
  /** True when the guard found counts already seeded and nothing ran. */
  skipped: boolean;
};

/** The three grouped recomputes, in the order the result reports them. */
const PASSES = [
  {
    key: "labels" as const,
    sql: `update labels
            set renderable_track_count = src.renderable,
                certified_finding_count = src.certified
          from (select label_id,
                       count(*) as renderable,
                       sum(case when is_catalogue = 0 then 1 else 0 end) as certified
                from tracks
                where label_id is not null
                group by label_id) src
          where labels.id = src.label_id`,
  },
  {
    key: "albums" as const,
    sql: `update albums
            set renderable_track_count = src.renderable,
                certified_finding_count = src.certified
          from (select album_id,
                       count(*) as renderable,
                       sum(case when is_catalogue = 0 then 1 else 0 end) as certified
                from tracks
                where album_id is not null
                group by album_id) src
          where albums.id = src.album_id`,
  },
  {
    key: "artists" as const,
    // The artists edge is the join table, so the group is over `track_artists ⋈ tracks` — the
    // inner join also drops an orphan edge whose track is gone, which is exactly right.
    sql: `update artists
            set renderable_track_count = src.renderable,
                certified_finding_count = src.certified
          from (select ta.artist_id,
                       count(*) as renderable,
                       sum(case when t.is_catalogue = 0 then 1 else 0 end) as certified
                from track_artists ta
                join tracks t on t.track_id = ta.track_id
                group by ta.artist_id) src
          where artists.id = src.artist_id`,
  },
];

/**
 * The core, taking any libSQL client so a test can drive it against an in-memory DB with the real
 * migrations applied (the `backfillIsCatalogue` precedent).
 */
export async function backfillHubCounts(
  client: Client,
  options: { force?: boolean } = {},
): Promise<HubCountsBackfillResult> {
  if (!options.force) {
    const seeded = await client.execute(
      `select count(*) as n from labels where renderable_track_count > 0`,
    );

    if (Number(seeded.rows[0]?.n ?? 0) > 0) {
      return { skipped: true };
    }
  }

  const filled = { albums: 0, artists: 0, labels: 0 };

  for (const pass of PASSES) {
    const result = await client.execute(pass.sql);
    filled[pass.key] = result.rowsAffected;
  }

  return { filled, skipped: false };
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
  const force = process.argv.includes("--force");
  const result = await backfillHubCounts(client, { force });

  if (result.skipped) {
    console.log("hub counts backfill: already backfilled — skipped (pass --force to re-run).");

    return;
  }

  const filled = result.filled ?? { albums: 0, artists: 0, labels: 0 };

  console.log(
    `hub counts backfill: ${filled.labels} label(s), ${filled.albums} album(s), ${filled.artists} artist(s) counted.`,
  );
}

if (import.meta.main) {
  await main();
}
