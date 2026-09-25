#!/usr/bin/env bun

import { type Client, type InStatement, createClient } from "@libsql/client";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { markDueWorkSourceMaintenanceFromSelectStatements } from "../src/lib/server/due-work";

export type HubCountsBackfillResult = {
  filled?: { albums: number; artists: number; labels: number };

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
    } catch {}
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
    } catch {}

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
    } catch {}

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
