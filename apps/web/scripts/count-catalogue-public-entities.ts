#!/usr/bin/env bun

import { $ } from "bun";
import { type Client, createClient } from "@libsql/client/web";
import { CATALOGUE_PUBLIC_ENTITY_COUNT_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { ALBUM_INDEX_MIN_TRACKS } from "../src/lib/server/albums";
import { ARTIST_INDEX_MIN_FINDINGS } from "../src/lib/server/artists";
import { LABEL_INDEX_MIN_TRACKS } from "../src/lib/server/labels";

type EntityVolume = {
  indexableCertified: number;
  indexableFree: number;
  reachableCertified: number;
  reachableFree: number;
};

function asCount(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : 0;
}

async function countEntity(client: Client, linkSql: string, floor: number): Promise<EntityVolume> {
  const result = await client.execute({
    args: [floor, floor],
    sql: `select
            sum(cert_flag) as reachable_certified,
            sum(1 - cert_flag) as reachable_free,
            sum(case when renderable >= ? and cert_flag = 1 then 1 else 0 end) as indexable_certified,
            sum(case when renderable >= ? and cert_flag = 0 then 1 else 0 end) as indexable_free
          from (
            ${linkSql}
          )`,
  });

  const row = result.rows[0] ?? {};

  return {
    indexableCertified: asCount(row["indexable_certified"]),
    indexableFree: asCount(row["indexable_free"]),
    reachableCertified: asCount(row["reachable_certified"]),
    reachableFree: asCount(row["reachable_free"]),
  };
}

const ALBUM_INNER = `
  select albums.id as id,
         max(case when findings.log_id is not null then 1 else 0 end) as cert_flag,
         sum(case when findings.log_id is not null then 1 else 0 end)
           + sum(case when tracks.track_id is not null and findings.track_id is null then 1 else 0 end)
             as renderable
  from albums
  left join tracks on tracks.album_id = albums.id
  left join findings on findings.track_id = tracks.track_id
  group by albums.id`;

const LABEL_INNER = `
  select labels.id as id,
         max(case when findings.log_id is not null then 1 else 0 end) as cert_flag,
         sum(case when findings.log_id is not null then 1 else 0 end)
           + sum(case when tracks.track_id is not null and findings.track_id is null then 1 else 0 end)
             as renderable
  from labels
  left join tracks on tracks.label_id = labels.id
  left join findings on findings.track_id = tracks.track_id
  group by labels.id`;

const ARTIST_INNER = `
  select a.id as id,
         max(case when findings.log_id is not null then 1 else 0 end) as cert_flag,
         sum(case when findings.log_id is not null then 1 else 0 end)
           + sum(case when tracks.track_id is not null and findings.track_id is null then 1 else 0 end)
             as renderable
  from artists a
  left join track_artists ta on ta.artist_id = a.id
  left join tracks on tracks.track_id = ta.track_id
  left join findings on findings.track_id = tracks.track_id
  group by a.id`;

function reportLine(kind: string, floor: number, v: EntityVolume): string {
  const reachableTotal = v.reachableCertified + v.reachableFree;
  const indexableTotal = v.indexableCertified + v.indexableFree;

  return [
    `${kind} (floor ${floor} renderable tracks):`,
    `  reachable (a page renders): ${reachableTotal}`,
    `    certified:     ${v.reachableCertified}`,
    `    findings-free: ${v.reachableFree}`,
    `  indexable + in sitemap:     ${indexableTotal}`,
    `    certified:     ${v.indexableCertified}`,
    `    findings-free: ${v.indexableFree}`,
  ].join("\n");
}

const ITEM = process.env.FLUNCLE_TURSO_OP_ITEM;

async function readSecret(field: string): Promise<string> {
  try {
    const value = await $`op read ${`${ITEM}/${field}`}`.text();

    return value.trim();
  } catch {
    throw new Error(
      `Could not read ${field} from 1Password (${ITEM}). Unlock 1Password and enable its CLI integration, then retry.`,
    );
  }
}

async function main(): Promise<void> {
  if (!ITEM) {
    throw new Error(
      "Set FLUNCLE_TURSO_OP_ITEM to the 1Password item holding the production Turso credentials — see the ops runbook note.",
    );
  }

  const url = await readSecret("TURSO_DATABASE_URL");
  const authToken = await readSecret("TURSO_AUTH_TOKEN");

  const client = createClient({
    authToken,
    concurrency: CATALOGUE_PUBLIC_ENTITY_COUNT_DB_CONCURRENCY,
    intMode: "bigint",
    url,
  });

  const [albums, labels, artists] = await Promise.all([
    countEntity(client, ALBUM_INNER, ALBUM_INDEX_MIN_TRACKS),
    countEntity(client, LABEL_INNER, LABEL_INDEX_MIN_TRACKS),
    countEntity(client, ARTIST_INNER, ARTIST_INDEX_MIN_FINDINGS),
  ]);

  console.log("Catalogue-publicness volume (read-only, production):\n");
  console.log(reportLine("Albums", ALBUM_INDEX_MIN_TRACKS, albums));
  console.log("");
  console.log(reportLine("Labels", LABEL_INDEX_MIN_TRACKS, labels));
  console.log("");
  console.log(reportLine("Artists", ARTIST_INDEX_MIN_FINDINGS, artists));
}

if (import.meta.main) {
  await main();
}
