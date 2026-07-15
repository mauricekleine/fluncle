#!/usr/bin/env bun
/**
 * THE ALBUM-GRAPH ONE-OFF BACKFILL — operator-run, ONCE, by hand. NOT in the deploy chain.
 *
 * IT HITS PRODUCTION TURSO. Run it on the operator machine after this migration ships:
 *   `bun run --cwd apps/web scripts/backfill-album-graph.ts`
 * It reads `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` from the environment (locally, `.dev.vars`).
 *
 * WHY IT IS ONE-OFF, NOT A RECURRING DEPLOY STEP. The album edge is now written INLINE: the
 * publish path calls `linkTrackToAlbum` on a certified add, and the catalogue crawler ensures +
 * links the album at crawl time, folded on the release-group MBID (`ensureAlbum`, lib/server/
 * albums.ts + crawl.ts). So there is nothing left to reconcile on every push — the recurring
 * `db:backfill` album step is gone. This script exists only to catch HISTORY up: rows written
 * before the inline path existed.
 *
 * Two steps, IDEMPOTENT, the exact slug resolution the inline path uses when it carries no mbid:
 *
 *   1. MINT — an `albums` row for every distinct `tracks.album` carried by a CERTIFIED finding,
 *      folded by slug (`slugify(tracks.album) = albums.slug`). It seeds from the finding join,
 *      NOT a bare `tracks` scan: an album earns an entity, a page, and a sitemap slot because
 *      Fluncle FOUND something on it. Minting off the raw catalogue would balloon the `/albums`
 *      index from archive-sized to catalogue-sized.
 *
 *   2. LINK — the `tracks.album_id` pointer for every track whose album HAS a row, certified or
 *      not. This is the half that fills the quieter rows on an album page, and the path by which
 *      a track written before the inline link existed is folded into the graph.
 *
 * THE `release_group_mbid` COLUMN. A legacy `albums` row has no stored release group — the
 * `tracks` table never captured one, so a pure-DB script cannot derive it and this script does
 * NOT invent one (it mints/links by slug, mbid NULL). Those NULLs are populated LIVE, over time,
 * by the crawler's ADOPT path: the next time it walks a release in that group, `ensureAlbum`
 * resolves the album by slug and stamps the mbid onto it (fill-empty-only). So the fold-on-mbid
 * self-heals through the running crawler rather than through a one-shot MusicBrainz sweep here.
 *
 * Unlike labels, an album carries NO operator control — no seed state, no ruling. There is
 * nothing for a human to decide about a record. See docs/album-entity.md.
 */
import { type Client, createClient } from "@libsql/client";
import { slugify } from "@fluncle/contracts/util/galaxy-slug";
import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type AlbumsBackfillResult = {
  /** Tracks whose `album_id` pointer this run stamped. */
  linked: number;
  minted: number;
};

/** Coerce a libSQL scalar cell to text — these columns are TEXT, always strings. */
function asText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }

  return "";
}

/**
 * The idempotent core, taking any libSQL client so a test can drive it against an in-memory
 * database with the real migrations applied.
 */
export async function backfillAlbums(client: Client): Promise<AlbumsBackfillResult> {
  const now = new Date().toISOString();
  const result: AlbumsBackfillResult = { linked: 0, minted: 0 };

  // ── 1. MINT — one row per distinct album on a certified finding, folded by slug.
  const distinct = await client.execute({
    sql: `select tracks.album as album from findings join tracks on tracks.track_id = findings.track_id
          where tracks.album is not null and trim(tracks.album) <> ''
          group by tracks.album`,
  });

  // First spelling wins per slug. Stable across runs: a row is only ever inserted once.
  const bySlug = new Map<string, string>();

  for (const row of distinct.rows) {
    const raw = asText(row.album).trim();
    const slug = slugify(raw);

    if (slug !== "" && !bySlug.has(slug)) {
      bySlug.set(slug, raw);
    }
  }

  for (const [slug, name] of bySlug) {
    const inserted = await client.execute({
      args: [`alb_${randomUUID()}`, name, slug, now, now],
      sql: `insert into albums (id, name, slug, created_at, updated_at)
            values (?, ?, ?, ?, ?)
            on conflict (slug) do nothing`,
    });

    result.minted += inserted.rowsAffected;
  }

  // ── 2. LINK — the pointer, for every track whose album now has a row. Runs AFTER the
  // mint, so an album minted this very run is pointed at.
  result.linked = await linkTracksToAlbums(client);

  return result;
}

/**
 * Stamp `tracks.album_id` on every track that carries an album string, has no pointer yet,
 * and has an `albums` row to point at.
 *
 * The fold happens here in TS (SQLite has no `slugify`), but what it folds is the UNLINKED
 * set — drained through `tracks_album_id_idx`, and empty once the inline path has caught up —
 * never the whole catalogue.
 */
export async function linkTracksToAlbums(client: Client): Promise<number> {
  const unlinked = await client.execute({
    sql: `select album from tracks
          where album_id is null and album is not null and trim(album) <> ''
          group by album`,
  });

  let linked = 0;

  for (const row of unlinked.rows) {
    const raw = asText(row.album).trim();
    const slug = slugify(raw);

    if (slug === "") {
      continue;
    }

    const found = await client.execute({
      args: [slug],
      sql: `select id from albums where slug = ? limit 1`,
    });
    const albumId = found.rows[0]?.id;

    if (typeof albumId !== "string") {
      continue;
    }

    const updated = await client.execute({
      args: [albumId, raw],
      sql: `update tracks set album_id = ? where album_id is null and trim(album) = ?`,
    });

    linked += updated.rowsAffected;
  }

  return linked;
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
  const result = await backfillAlbums(client);

  console.log(`album-graph backfill: ${result.minted} minted · ${result.linked} linked.`);
}

if (import.meta.main) {
  await main();
}
