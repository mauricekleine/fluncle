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
 * THE SHAPE. One single-pass grouped aggregate per table is materialized into a uniquely named
 * ordinary staging relation, then both repair rails and the counter update read that bounded
 * relation. Create/populate/mark/apply/drop are one atomic write batch, so success leaves no table
 * and failure rolls its creation back. There is no per-entity loop and no repeated archive scan.
 * `certified` rides `tracks.is_catalogue = 0` (keystone 1's materialized discriminator), never a
 * `findings` join. The artists pass groups over `track_artists ⋈ tracks`, the ~2×-tracks edge table.
 * Every entity LEFT JOINs that aggregate: an already-empty entity stays untouched, while an entity
 * that lost its final track is staged back to zero.
 *
 * WHY THE GUARD, AND WHY IT IS NOT OPTIONAL. `db:backfill` runs on EVERY deploy, and this is the
 * one recompute-from-truth in the whole design — the exact shape the write paths are forbidden to
 * use, because at 150k hosted it measured 27,400 ms against ~200 ms for delta arithmetic. Paying
 * that on every deploy would be absurd, and re-running it over live counters would also silently
 * paper over a real maintenance bug (the drift a future reconciliation sweep is meant to REPORT).
 * So a token-owned `settings` marker state machine makes later deploys no-ops. A run must write and
 * read back its own `running:<uuid>` before any pass, and re-check that ownership immediately before
 * every corpus batch; only that token may conditionally transition to `complete:v1` after all three
 * bounded pass transactions succeed. A database completed by the older marker-less script pays one
 * safe recompute to adopt `complete:v1`, then never scans again.
 * `--force` claims a fresh token over the old completion — the operator's escape hatch after an
 * out-of-band bulk edge write (e.g. `scripts/backfill-artist-links.ts`, the whole-corpus artist-link
 * reconciler, or a prune that deleted tracks straight out of the database). Claim/completion writes
 * are read back and retried boundedly because a transport failure can be pre- or post-commit. If the
 * database stays unavailable, the run throws; retry explicitly with `--force` after it recovers.
 *
 * Reads `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` from the environment (locally from
 * apps/web/.dev.vars), exactly like `db:migrate`.
 */
import { type Client, type InStatement, createClient } from "@libsql/client";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { markDueWorkSourceMaintenanceFromSelectStatements } from "../src/lib/server/due-work";

export type HubCountsBackfillResult = {
  /** Rows written per entity table. Absent when the run was skipped. */
  filled?: { albums: number; artists: number; labels: number };
  /** True when the durable completion marker exists and nothing ran. */
  skipped: boolean;
};

export const HUB_COUNTS_BACKFILL_MARKER_KEY = "backfill_hub_counts_v1_state";
export const HUB_COUNTS_BACKFILL_COMPLETE_VALUE = "complete:v1";
const HUB_COUNTS_BACKFILL_RUNNING_PREFIX = "running:";
const HUB_COUNTS_MARKER_RETRY_LIMIT = 3;

type HubCountKey = "albums" | "artists" | "labels";

declare const hubCountStageTableBrand: unique symbol;
type HubCountStageTable = string & { readonly [hubCountStageTableBrand]: true };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HUB_COUNT_STAGE_TABLE_PATTERN =
  /^backfill_hub_counts_(?:albums|artists|labels)_stage_[0-9a-f]{32}$/u;

function assertCanonicalRunId(runId: string): void {
  if (!UUID_PATTERN.test(runId)) {
    throw new Error("hub counts backfill: staging run id must be a canonical UUID");
  }
}

/** Build the only identifier shape this script is allowed to interpolate into staging SQL. */
export function createHubCountStageTableName(key: HubCountKey, runId: string): HubCountStageTable {
  assertCanonicalRunId(runId);

  const tableName = `backfill_hub_counts_${key}_stage_${runId.replaceAll("-", "")}`;
  if (!HUB_COUNT_STAGE_TABLE_PATTERN.test(tableName)) {
    throw new Error("hub counts backfill: generated an unsafe staging table identifier");
  }

  return tableName as HubCountStageTable;
}

async function readCompletionMarker(client: Client): Promise<string | undefined> {
  const result = await client.execute({
    args: [HUB_COUNTS_BACKFILL_MARKER_KEY],
    sql: `select value from settings where key = ? limit 1`,
  });
  const value = result.rows[0]?.value;

  return typeof value === "string" ? value : undefined;
}

async function readInitialCompletionMarker(client: Client): Promise<string | undefined> {
  for (let attempt = 0; attempt < HUB_COUNTS_MARKER_RETRY_LIMIT; attempt += 1) {
    try {
      return await readCompletionMarker(client);
    } catch {
      // A transient read before claiming is safe to retry: no backfill mutation has begun.
    }
  }

  throw new Error(
    "hub counts backfill: completion state is unavailable; no backfill mutation ran — retry explicitly with --force after the database recovers",
  );
}

async function claimBackfillRun(
  client: Client,
  runId: string,
  force: boolean,
): Promise<"complete" | "owned"> {
  assertCanonicalRunId(runId);
  const runningValue = `${HUB_COUNTS_BACKFILL_RUNNING_PREFIX}${runId}`;

  for (let attempt = 0; attempt < HUB_COUNTS_MARKER_RETRY_LIMIT; attempt += 1) {
    try {
      await client.execute({
        args: [
          HUB_COUNTS_BACKFILL_MARKER_KEY,
          runningValue,
          runningValue,
          force ? 1 : 0,
          HUB_COUNTS_BACKFILL_COMPLETE_VALUE,
        ],
        sql: `insert into settings (key, value) values (?, ?)
              on conflict(key) do update set value = ?
              where ? = 1 or settings.value <> ?`,
      });
    } catch {
      // The write may have failed before commit or committed before the transport reported failure.
    }

    let observed: string | undefined;
    try {
      observed = await readCompletionMarker(client);
    } catch {
      continue;
    }

    if (observed === runningValue) {
      return "owned";
    }
    if (!force && observed === HUB_COUNTS_BACKFILL_COMPLETE_VALUE) {
      return "complete";
    }
    // Force must replace an old complete value. Any absent, stale, malformed, or competing running
    // state is safe to retry because no archive mutation begins until our own token is read back.
  }

  throw new Error(
    "hub counts backfill: could not durably establish run ownership; no backfill mutation ran — retry explicitly with --force after the database recovers",
  );
}

async function completeBackfillRun(client: Client, runId: string): Promise<void> {
  const runningValue = `${HUB_COUNTS_BACKFILL_RUNNING_PREFIX}${runId}`;

  for (let attempt = 0; attempt < HUB_COUNTS_MARKER_RETRY_LIMIT; attempt += 1) {
    try {
      await client.execute({
        args: [HUB_COUNTS_BACKFILL_COMPLETE_VALUE, HUB_COUNTS_BACKFILL_MARKER_KEY, runningValue],
        sql: `update settings set value = ? where key = ? and value = ?`,
      });
    } catch {
      // As with claim, only the read-back can distinguish a pre-commit failure from committed work.
    }

    let observed: string | undefined;
    try {
      observed = await readCompletionMarker(client);
    } catch {
      continue;
    }

    if (observed === HUB_COUNTS_BACKFILL_COMPLETE_VALUE) {
      return;
    }
    if (observed !== runningValue) {
      throw new Error(
        "hub counts backfill: run ownership changed before completion; the newer owner must complete",
      );
    }
  }

  throw new Error(
    "hub counts backfill: completion could not be durably confirmed; retry explicitly with --force after the database recovers",
  );
}

async function assertBackfillRunOwnership(
  client: Client,
  runId: string,
  pass: HubCountKey,
): Promise<void> {
  const runningValue = `${HUB_COUNTS_BACKFILL_RUNNING_PREFIX}${runId}`;

  for (let attempt = 0; attempt < HUB_COUNTS_MARKER_RETRY_LIMIT; attempt += 1) {
    let observed: string | undefined;
    try {
      observed = await readCompletionMarker(client);
    } catch {
      continue;
    }

    if (observed === runningValue) {
      return;
    }

    throw new Error(
      `hub counts backfill: run ownership changed before the ${pass} corpus pass; no ${pass} mutation ran`,
    );
  }

  throw new Error(
    `hub counts backfill: ownership could not be confirmed before the ${pass} corpus pass; no ${pass} mutation ran — retry explicitly with --force after the database recovers`,
  );
}

type HubCountPass = {
  applyHubCountsStatement: (stageTable: HubCountStageTable) => InStatement;
  key: HubCountKey;
  marker: (stageTable: HubCountStageTable) => InStatement[];
  stageHubCountsStatement: (stageTable: HubCountStageTable) => InStatement;
};

function createStageStatement(stageTable: HubCountStageTable): InStatement {
  return `create table ${stageTable} (
    subject_id text primary key,
    renderable integer not null,
    certified integer not null
  )`;
}

function dropStageStatement(stageTable: HubCountStageTable): InStatement {
  return `drop table ${stageTable}`;
}

/** The three staged recomputes, in the order the result reports them. */
const PASSES = [
  {
    applyHubCountsStatement: (stageTable) => ({
      sql: `update labels
            set renderable_track_count = staged.renderable,
                certified_finding_count = staged.certified
          from ${stageTable} staged
          where labels.id = staged.subject_id`,
    }),
    key: "labels" as const,
    marker: (stageTable) =>
      markDueWorkSourceMaintenanceFromSelectStatements(
        "label",
        {
          sql: `select subject_id from ${stageTable}`,
        },
        { producer: "backfill-hub-counts-labels" },
      ),
    stageHubCountsStatement: (stageTable) => ({
      sql: `insert into ${stageTable} (subject_id, renderable, certified)
            select labels.id,
                   coalesce(src.renderable, 0),
                   coalesce(src.certified, 0)
            from labels
            left join (select label_id,
                              count(*) as renderable,
                              sum(case when is_catalogue = 0 then 1 else 0 end) as certified
                       from tracks
                       where label_id is not null
                       group by label_id) src on src.label_id = labels.id
            where labels.renderable_track_count <> coalesce(src.renderable, 0)
               or labels.certified_finding_count <> coalesce(src.certified, 0)`,
    }),
  },
  {
    applyHubCountsStatement: (stageTable) => ({
      sql: `update albums
            set renderable_track_count = staged.renderable,
                certified_finding_count = staged.certified
          from ${stageTable} staged
          where albums.id = staged.subject_id`,
    }),
    key: "albums" as const,
    marker: (stageTable) =>
      markDueWorkSourceMaintenanceFromSelectStatements(
        "album",
        {
          sql: `select subject_id from ${stageTable}`,
        },
        { producer: "backfill-hub-counts-albums" },
      ),
    stageHubCountsStatement: (stageTable) => ({
      sql: `insert into ${stageTable} (subject_id, renderable, certified)
            select albums.id,
                   coalesce(src.renderable, 0),
                   coalesce(src.certified, 0)
            from albums
            left join (select album_id,
                              count(*) as renderable,
                              sum(case when is_catalogue = 0 then 1 else 0 end) as certified
                       from tracks
                       where album_id is not null
                       group by album_id) src on src.album_id = albums.id
            where albums.renderable_track_count <> coalesce(src.renderable, 0)
               or albums.certified_finding_count <> coalesce(src.certified, 0)`,
    }),
  },
  // The artists edge is the join table, so the group is over `track_artists ⋈ tracks` — the inner
  // join also drops an orphan edge whose track is gone, which is exactly right.
  {
    applyHubCountsStatement: (stageTable) => ({
      sql: `update artists
            set renderable_track_count = staged.renderable,
                certified_finding_count = staged.certified
          from ${stageTable} staged
          where artists.id = staged.subject_id`,
    }),
    key: "artists" as const,
    marker: (stageTable) =>
      markDueWorkSourceMaintenanceFromSelectStatements(
        "artist",
        {
          sql: `select subject_id from ${stageTable}`,
        },
        { producer: "backfill-hub-counts-artists" },
      ),
    stageHubCountsStatement: (stageTable) => ({
      sql: `insert into ${stageTable} (subject_id, renderable, certified)
            select artists.id,
                   coalesce(src.renderable, 0),
                   coalesce(src.certified, 0)
            from artists
            left join (select ta.artist_id,
                              count(*) as renderable,
                              sum(case when t.is_catalogue = 0 then 1 else 0 end) as certified
                       from track_artists ta
                       join tracks t on t.track_id = ta.track_id
                       group by ta.artist_id) src on src.artist_id = artists.id
            where artists.renderable_track_count <> coalesce(src.renderable, 0)
               or artists.certified_finding_count <> coalesce(src.certified, 0)`,
    }),
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
  const markerValue = await readInitialCompletionMarker(client);

  if (!options.force && markerValue === HUB_COUNTS_BACKFILL_COMPLETE_VALUE) {
    return { skipped: true };
  }

  const filled = { albums: 0, artists: 0, labels: 0 };
  const runId = randomUUID();
  const claim = await claimBackfillRun(client, runId, options.force === true);
  if (claim === "complete") {
    return { skipped: true };
  }

  for (const pass of PASSES) {
    const stageTable = createHubCountStageTableName(pass.key, runId);
    const statements = [
      createStageStatement(stageTable),
      pass.stageHubCountsStatement(stageTable),
      ...pass.marker(stageTable),
      pass.applyHubCountsStatement(stageTable),
      dropStageStatement(stageTable),
    ];
    await assertBackfillRunOwnership(client, runId, pass.key);
    const results = await client.batch(statements, "write");
    filled[pass.key] = results.at(-2)?.rowsAffected ?? 0;
  }

  await completeBackfillRun(client, runId);

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
