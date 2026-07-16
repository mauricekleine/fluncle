#!/usr/bin/env bun
/**
 * THE CATALOGUE-PUBLICNESS VOLUME READOUT — operator-run, READ-ONLY, by hand. NOT in the deploy
 * chain, and NEVER a write: every statement is a `select count(*)`-shaped aggregate.
 *
 * IT HITS PRODUCTION TURSO. Run it on the operator machine to see the number the catalogue-graph
 * publicness slice actually exposes before merging that slice:
 *   `bun run --cwd apps/web scripts/count-catalogue-public-entities.ts`
 *
 * Production credentials are never read from `.dev.vars` (in this repo that points at the tiny
 * LOCAL per-worktree dev DB, so it would report a meaningless local count). They are read at run
 * time from 1Password — point `FLUNCLE_TURSO_OP_ITEM` at the item that holds the production Turso
 * credentials (the same var + item `db-pull-prod.ts` uses) — so `op` must be unlocked, and that
 * biometric unlock IS the human-in-the-loop gate on touching prod.
 *
 * WHY IT EXISTS. The slice brings albums + artists to the same posture labels already have: a
 * discovered, findings-free entity's PAGE renders and (once it clears the thin-content floor)
 * enters the sitemap, exactly as a discovered label does. That is a deliberate expansion of the
 * public surface, and its SIZE is a review input — how many pages does a wide crawl light up, and
 * how many of those are indexable? This script answers that, split certified vs findings-free, so
 * the operator merges on a real number rather than a guess.
 *
 * WHAT IT MEASURES, per entity kind (albums / labels / artists):
 *   · REACHABLE — every entity ROW renders a page now (the resolver 404s only a slug with no row),
 *     so this is the count of rows, split by whether the entity carries a certified finding.
 *   · INDEXABLE — the subset whose page clears the thin-content floor (RENDERABLE tracks: the
 *     certified findings PLUS the quieter uncertified catalogue rows), i.e. exactly what enters the
 *     sitemap. Split the same way. The floor is the very constant each surface's `indexable` uses.
 *
 * The renderable-track count mirrors the sitemap reads byte-for-byte: a finding counts when it is
 * coordinate-bearing (`findings.log_id is not null`); a catalogue row is a linked track with no
 * findings row at all. A track linked to an entity but carrying an uncertified (log_id-null)
 * findings row is in neither — it is not renderable, and the page renders it nowhere.
 */
import { $ } from "bun";
import { type Client, createClient } from "@libsql/client/web";
import { ALBUM_INDEX_MIN_TRACKS } from "../src/lib/server/albums";
import { ARTIST_INDEX_MIN_FINDINGS } from "../src/lib/server/artists";
import { LABEL_INDEX_MIN_TRACKS } from "../src/lib/server/labels";

/** The split volume for one entity kind. */
type EntityVolume = {
  indexableCertified: number;
  indexableFree: number;
  reachableCertified: number;
  reachableFree: number;
};

/** Coerce a libSQL scalar count cell (number | bigint) to a JS number. */
function asCount(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : 0;
}

/**
 * Count one entity kind's public volume in a SINGLE grouped aggregate. `linkSql` is the CONSTANT
 * join from an entity row down to its tracks (never input); `floor` is bound.
 *
 * The inner query yields one row per entity with two facts: `cert_flag` (does it carry any
 * certified finding) and `renderable` (findings + catalogue rows on the page). The outer query
 * buckets those into the four counts. A track-less entity row has renderable 0 and is counted as
 * reachable-and-findings-free, never indexable — it renders an empty page, exactly as the resolver
 * does.
 */
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

// One row per entity, carrying `cert_flag` (1 = has a certified finding) and `renderable` (the
// findings + catalogue tracks the page shows). `left join`s throughout so a track-less entity row
// still counts as reachable; the `tracks.track_id is not null` guard keeps a phantom left-joined
// row from being miscounted as a catalogue track.
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

/** Read one field of the prod-Turso 1Password item, exactly as `db-pull-prod.ts` does. */
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
  // intMode:"bigint" keeps large catalogue counts exact; `asCount` already narrows bigint → number.
  const client = createClient({ authToken, intMode: "bigint", url });

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
