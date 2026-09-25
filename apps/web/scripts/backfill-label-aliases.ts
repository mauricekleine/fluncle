#!/usr/bin/env bun

import { type Client, createClient } from "@libsql/client";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { labelFold, slugify } from "@fluncle/contracts/util/galaxy-slug";
import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDistributorLabel } from "../src/lib/label-distributors";

export type LabelAliasesBackfillResult = {
  candidates: number;

  dropped: number;

  hints: number;
};

function asText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }

  return "";
}

type AlbumLabelRow = {
  apple_raw: string;
  label_id: string;
  label_name: string;
  label_slug: string;
  n: number;
};

export async function backfillLabelAliases(client: Client): Promise<LabelAliasesBackfillResult> {
  const result: LabelAliasesBackfillResult = { candidates: 0, dropped: 0, hints: 0 };

  const rows = await client.execute({
    sql: `select a.id as album_id, a.record_label_raw as apple_raw,
                 l.id as label_id, l.name as label_name, l.slug as label_slug,
                 count(*) as n
          from albums a
          join tracks t on t.album_id = a.id
          join labels l on l.id = t.label_id
          where a.record_label_raw is not null and trim(a.record_label_raw) <> ''
          group by a.id, l.id
          order by a.id asc, n desc, l.name collate nocase asc`,
  });

  const byAlbum = new Map<string, { appleRaw: string; labels: AlbumLabelRow[] }>();

  for (const raw of rows.rows) {
    const albumId = asText(raw.album_id);
    const row: AlbumLabelRow = {
      apple_raw: asText(raw.apple_raw).trim(),
      label_id: asText(raw.label_id),
      label_name: asText(raw.label_name),
      label_slug: asText(raw.label_slug),
      n: Number(raw.n) || 0,
    };

    const entry = byAlbum.get(albumId);

    if (entry) {
      entry.labels.push(row);
    } else {
      byAlbum.set(albumId, { appleRaw: row.apple_raw, labels: [row] });
    }
  }

  const now = new Date().toISOString();

  for (const { appleRaw, labels } of byAlbum.values()) {
    const appleSlug = slugify(appleRaw);

    if (appleSlug === "") {
      continue;
    }

    if (isDistributorLabel(appleRaw)) {
      result.dropped += 1;
      continue;
    }

    const appleFold = labelFold(appleRaw);
    const foldMatch = labels.find((label) => labelFold(label.label_name) === appleFold);

    if (foldMatch) {
      if (appleSlug === foldMatch.label_slug) {
        continue;
      }

      result.candidates += await upsertAlias(client, now, {
        alias: appleRaw,
        aliasSlug: appleSlug,
        kind: "name",
        labelId: foldMatch.label_id,
      });
      continue;
    }

    const dominant = labels[0];

    if (dominant) {
      result.hints += await upsertAlias(client, now, {
        alias: appleRaw,
        aliasSlug: appleSlug,
        kind: "hint",
        labelId: dominant.label_id,
      });
    }
  }

  return result;
}

async function upsertAlias(
  client: Client,
  now: string,
  alias: { alias: string; aliasSlug: string; kind: "name" | "hint"; labelId: string },
): Promise<number> {
  const inserted = await client.execute({
    args: [`lba_${randomUUID()}`, alias.labelId, alias.alias, alias.aliasSlug, alias.kind, now],
    sql: `insert into label_aliases
            (id, label_id, alias, alias_slug, source, kind, status, created_at)
          values (?, ?, ?, ?, 'apple', ?, 'candidate', ?)
          on conflict (label_id, alias_slug, source) do nothing`,
  });

  return inserted.rowsAffected;
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
  const result = await backfillLabelAliases(client);

  console.log(
    `label aliases: ${result.candidates} candidates · ${result.hints} hints · ` +
      `${result.dropped} distributor(s) dropped.`,
  );
}

if (import.meta.main) {
  await main();
}
