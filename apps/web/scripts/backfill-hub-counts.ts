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
 * THE SHAPE. One single-pass grouped aggregate per table is materialized into a connection-local
 * TEMP relation, then both repair rails and the counter update read that bounded relation. There is
 * no per-entity loop and no repeated archive scan. `certified` rides `tracks.is_catalogue = 0`
 * (keystone 1's materialized discriminator), never a `findings` join. The artists pass groups over
 * `track_artists ⋈ tracks`, the ~2×-tracks edge table. An entity with zero linked tracks appears in
 * no group and keeps its DDL default of 0 — correct by construction.
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
import { type Client, type InStatement, createClient } from "@libsql/client";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { markDueWorkSourceMaintenanceFromSelectStatements } from "../src/lib/server/due-work";

export type HubCountsBackfillResult = {
  /** Rows written per entity table. Absent when the run was skipped. */
  filled?: { albums: number; artists: number; labels: number };
  /** True when the guard found counts already seeded and nothing ran. */
  skipped: boolean;
};

/**
 * Fixed internal identifiers only. A TEMP relation is connection-local, and create/populate/mark/
 * apply/drop all run in one `client.batch`, so concurrent forced runs cannot share staged subjects.
 */
const LABELS_STAGE_TABLE = "backfill_hub_counts_labels_stage";
const ALBUMS_STAGE_TABLE = "backfill_hub_counts_albums_stage";
const ARTISTS_STAGE_TABLE = "backfill_hub_counts_artists_stage";

type HubCountStageTable =
  | typeof ALBUMS_STAGE_TABLE
  | typeof ARTISTS_STAGE_TABLE
  | typeof LABELS_STAGE_TABLE;

type HubCountPass = {
  applyHubCountsStatement: () => InStatement;
  key: "albums" | "artists" | "labels";
  marker: () => InStatement[];
  stageHubCountsStatement: () => InStatement;
  stageTable: HubCountStageTable;
};

function createStageStatement(stageTable: HubCountStageTable): InStatement {
  return `create temp table if not exists ${stageTable} (
    subject_id text primary key,
    renderable integer not null,
    certified integer not null
  ) without rowid`;
}

function clearStageStatement(stageTable: HubCountStageTable): InStatement {
  return `delete from temp.${stageTable}`;
}

function dropStageStatement(stageTable: HubCountStageTable): InStatement {
  return `drop table temp.${stageTable}`;
}

/** The three staged recomputes, in the order the result reports them. */
const PASSES = [
  {
    applyHubCountsStatement: () => ({
      sql: `update labels
            set renderable_track_count = staged.renderable,
                certified_finding_count = staged.certified
          from temp.${LABELS_STAGE_TABLE} staged
          where labels.id = staged.subject_id`,
    }),
    key: "labels" as const,
    marker: () =>
      markDueWorkSourceMaintenanceFromSelectStatements(
        "label",
        {
          sql: `select subject_id from temp.${LABELS_STAGE_TABLE}`,
        },
        { producer: "backfill-hub-counts-labels" },
      ),
    stageHubCountsStatement: () => ({
      sql: `insert into temp.${LABELS_STAGE_TABLE} (subject_id, renderable, certified)
            select labels.id, src.renderable, src.certified
            from labels
            join (select label_id,
                         count(*) as renderable,
                         sum(case when is_catalogue = 0 then 1 else 0 end) as certified
                  from tracks
                  where label_id is not null
                  group by label_id) src on src.label_id = labels.id
            where labels.renderable_track_count <> src.renderable
               or labels.certified_finding_count <> src.certified`,
    }),
    stageTable: LABELS_STAGE_TABLE,
  },
  {
    applyHubCountsStatement: () => ({
      sql: `update albums
            set renderable_track_count = staged.renderable,
                certified_finding_count = staged.certified
          from temp.${ALBUMS_STAGE_TABLE} staged
          where albums.id = staged.subject_id`,
    }),
    key: "albums" as const,
    marker: () =>
      markDueWorkSourceMaintenanceFromSelectStatements(
        "album",
        {
          sql: `select subject_id from temp.${ALBUMS_STAGE_TABLE}`,
        },
        { producer: "backfill-hub-counts-albums" },
      ),
    stageHubCountsStatement: () => ({
      sql: `insert into temp.${ALBUMS_STAGE_TABLE} (subject_id, renderable, certified)
            select albums.id, src.renderable, src.certified
            from albums
            join (select album_id,
                         count(*) as renderable,
                         sum(case when is_catalogue = 0 then 1 else 0 end) as certified
                  from tracks
                  where album_id is not null
                  group by album_id) src on src.album_id = albums.id
            where albums.renderable_track_count <> src.renderable
               or albums.certified_finding_count <> src.certified`,
    }),
    stageTable: ALBUMS_STAGE_TABLE,
  },
  // The artists edge is the join table, so the group is over `track_artists ⋈ tracks` — the inner
  // join also drops an orphan edge whose track is gone, which is exactly right.
  {
    applyHubCountsStatement: () => ({
      sql: `update artists
            set renderable_track_count = staged.renderable,
                certified_finding_count = staged.certified
          from temp.${ARTISTS_STAGE_TABLE} staged
          where artists.id = staged.subject_id`,
    }),
    key: "artists" as const,
    marker: () =>
      markDueWorkSourceMaintenanceFromSelectStatements(
        "artist",
        {
          sql: `select subject_id from temp.${ARTISTS_STAGE_TABLE}`,
        },
        { producer: "backfill-hub-counts-artists" },
      ),
    stageHubCountsStatement: () => ({
      sql: `insert into temp.${ARTISTS_STAGE_TABLE} (subject_id, renderable, certified)
            select artists.id, src.renderable, src.certified
            from artists
            join (select ta.artist_id,
                         count(*) as renderable,
                         sum(case when t.is_catalogue = 0 then 1 else 0 end) as certified
                  from track_artists ta
                  join tracks t on t.track_id = ta.track_id
                  group by ta.artist_id) src on src.artist_id = artists.id
            where artists.renderable_track_count <> src.renderable
               or artists.certified_finding_count <> src.certified`,
    }),
    stageTable: ARTISTS_STAGE_TABLE,
  },
] satisfies HubCountPass[];

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
    const statements = [
      createStageStatement(pass.stageTable),
      clearStageStatement(pass.stageTable),
      pass.stageHubCountsStatement(),
      ...pass.marker(),
      pass.applyHubCountsStatement(),
      dropStageStatement(pass.stageTable),
    ];
    const results = await client.batch(statements, "write");
    filled[pass.key] = results.at(-2)?.rowsAffected ?? 0;
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
  const client = createClient(
    authToken
      ? { authToken, concurrency: REMOTE_DB_CONCURRENCY, url }
      : { concurrency: REMOTE_DB_CONCURRENCY, url },
  );
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
