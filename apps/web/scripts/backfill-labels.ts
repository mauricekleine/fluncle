#!/usr/bin/env bun

import { type Client, createClient } from "@libsql/client";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { slugify } from "@fluncle/contracts/util/galaxy-slug";
import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { hubCountDeltaStatement } from "../src/lib/server/hub-counts";
import { restaleCatalogueRankByLabelStatement } from "../src/lib/server/catalogue-rank-restale";
import {
  batchDueWorkSourceMutation,
  DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
  markDueWorkSourceMaintenanceFromSelectStatements,
  markDueWorkSourceMaintenanceStatements,
} from "../src/lib/server/due-work";

const SEED_MARKER_KEY = "labels_seeded_at";

const BOOTSTRAP_DISABLED = [
  "anjunabeats",
  "armada-music",
  "atlantic-records-uk",
  "axtone-records",
  "counter-records",

  "experts-only",
  "positiva",
  "tomorrowland-music",
  "tomorrowland-music-experts-only",
  "zerothree",
];

const BOOTSTRAP_UNDECIDED = ["chelou", "spiration-music", "ukf"];

export type LabelsBackfillResult = {
  bootstrapped: boolean;
  disabled: number;
  enabled: number;

  linked: number;
  minted: number;
  undecided: number;
};

export async function loadConfirmedAliases(client: Client): Promise<Map<string, string>> {
  const rows = await client.execute({
    sql: `select alias_slug, label_id from label_aliases where status = 'confirmed'`,
  });

  const bySlug = new Map<string, string>();

  for (const row of rows.rows) {
    const slug = asText(row.alias_slug);
    const labelId = asText(row.label_id);

    if (slug !== "" && labelId !== "") {
      bySlug.set(slug, labelId);
    }
  }

  return bySlug;
}

export async function linkTracksToLabels(
  client: Client,
  confirmedAliases?: Map<string, string>,
): Promise<number> {
  const aliases = confirmedAliases ?? (await loadConfirmedAliases(client));
  const unlinked = await client.execute({
    sql: `select label from tracks
          where label_id is null and label is not null and trim(label) <> ''
          group by label`,
  });

  let linked = 0;

  for (const row of unlinked.rows) {
    const raw = asText(row.label).trim();
    const slug = slugify(raw);

    if (slug === "") {
      continue;
    }

    const found = await client.execute({
      args: [slug],
      sql: `select id from labels where slug = ? limit 1`,
    });

    const labelId = found.rows[0]?.id ?? aliases.get(slug);

    if (typeof labelId !== "string") {
      continue;
    }

    const census = await client.execute({
      args: [raw],
      sql: `select count(*) as n, sum(case when is_catalogue = 0 then 1 else 0 end) as cert
            from tracks
            where label_id is null and trim(label) = ?`,
    });
    const renderable = Number(census.rows[0]?.n ?? 0);

    if (renderable === 0) {
      continue;
    }

    const certified = Number(census.rows[0]?.cert ?? 0);

    const results = await client.batch(
      [
        ...markDueWorkSourceMaintenanceFromSelectStatements(
          "track",
          {
            args: [raw],
            sql: `select track_id as subject_id from tracks
                  where label_id is null and trim(label) = ?`,
          },
          { producer: "backfill-label-link" },
        ),
        {
          args: [labelId, raw],
          sql: `update tracks set label_id = ? where label_id is null and trim(label) = ?`,
        },
        hubCountDeltaStatement("labels", labelId, { certified, renderable }),
      ],
      "write",
    );

    linked += results.at(-2)?.rowsAffected ?? 0;
  }

  return linked;
}

function asText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }

  return "";
}

export const DISTINCT_FINDING_LABELS_SQL = `select tracks.label as label
      from findings cross join tracks on tracks.track_id = findings.track_id
      where tracks.label is not null and trim(tracks.label) <> ''
      group by tracks.label`;

export async function backfillLabels(client: Client): Promise<LabelsBackfillResult> {
  const now = new Date().toISOString();
  const result: LabelsBackfillResult = {
    bootstrapped: false,
    disabled: 0,
    enabled: 0,
    linked: 0,
    minted: 0,
    undecided: 0,
  };

  const confirmedAliases = await loadConfirmedAliases(client);

  const distinct = await client.execute({ sql: DISTINCT_FINDING_LABELS_SQL });

  const bySlug = new Map<string, string>();

  for (const row of distinct.rows) {
    const raw = asText(row.label).trim();
    const slug = slugify(raw);

    if (slug !== "" && !confirmedAliases.has(slug) && !bySlug.has(slug)) {
      bySlug.set(slug, raw);
    }
  }

  for (const [slug, name] of bySlug) {
    const labelId = `lbl_${randomUUID()}`;
    const [inserted] = await batchDueWorkSourceMutation(
      client,
      [
        {
          args: [labelId, name, slug, now, now],
          sql: `insert into labels (id, name, slug, created_at, updated_at)
                values (?, ?, ?, ?, ?)
                on conflict (slug) do nothing`,
        },
      ],
      [{ subjectId: labelId, subjectType: "label" }],
      { onlyIfLastSourceStatementChanged: true, producer: "backfill-label-mint" },
    );

    result.minted += inserted?.rowsAffected ?? 0;
  }

  result.linked = await linkTracksToLabels(client, confirmedAliases);

  const marker = await client.execute({
    args: [SEED_MARKER_KEY],
    sql: `select value from settings where key = ? limit 1`,
  });

  if (marker.rows.length > 0) {
    const states = await client.execute({
      sql: `select seed_state, count(*) as n from labels group by seed_state`,
    });

    for (const row of states.rows) {
      const n = Number(row.n) || 0;

      if (asText(row.seed_state) === "enabled") {
        result.enabled = n;
      } else if (asText(row.seed_state) === "disabled") {
        result.disabled = n;
      } else {
        result.undecided = n;
      }
    }

    return result;
  }

  const rows = await client.execute({
    sql: `select id, slug, seed_state from labels where ruled_at is null`,
  });

  for (const row of rows.rows) {
    const slug = asText(row.slug);
    const state = BOOTSTRAP_DISABLED.includes(slug)
      ? "disabled"
      : BOOTSTRAP_UNDECIDED.includes(slug)
        ? "undecided"
        : "enabled";

    const labelId = asText(row.id);
    if (asText(row.seed_state) !== state) {
      const restale = restaleCatalogueRankByLabelStatement(labelId);
      await client.batch(
        [
          {
            args: [state, now, labelId, state],
            sql: `update labels set seed_state = ?, updated_at = ?
                  where id = ? and ruled_at is null and seed_state <> ?`,
          },
          ...markDueWorkSourceMaintenanceStatements(
            [
              { subjectId: labelId, subjectType: "label" },
              {
                subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
                subjectType: "track",
              },
            ],
            { onlyIfPreviousStatementChanged: true, producer: "backfill-label-seed" },
          ),
          {
            ...restale,
            sql: `${restale.sql} and changes() > 0`,
          },
          ...markDueWorkSourceMaintenanceFromSelectStatements(
            "track",
            {
              args: [labelId],
              sql: `select track_id as subject_id from tracks
                    where label_id = ? and changes() > 0`,
            },
            { producer: "backfill-label-seed" },
          ),
        ],
        "write",
      );
    }

    result[state] += 1;
  }

  await client.execute({
    args: [SEED_MARKER_KEY, now],
    sql: `insert into settings (key, value) values (?, ?)
          on conflict (key) do nothing`,
  });

  result.bootstrapped = true;

  return result;
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
  const result = await backfillLabels(client);

  console.log(
    `labels backfill: ${result.minted} minted · ${result.linked} linked · ${result.enabled} enabled, ` +
      `${result.disabled} skipped, ${result.undecided} undecided` +
      `${result.bootstrapped ? " (D7 bootstrap applied)" : ""}.`,
  );
}

if (import.meta.main) {
  await main();
}
