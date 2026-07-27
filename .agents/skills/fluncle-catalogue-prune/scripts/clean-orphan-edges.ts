#!/usr/bin/env bun
// One-time cleanup: delete `track_artists` edges whose track no longer exists.
//
// An ORPHANED EDGE is a row in `track_artists` pointing at a `tracks` row that has been deleted.
// Production carried 62 of them across 36 artists (measured 2026-07-26), left by out-of-band track
// deletion — a purge that removed the track and not its edge. The purge no longer leaves them
// (`deleteTracksWithEdges` in lib.ts kills both in one transaction); this sweeps up what is
// already there. It is safe to re-run: once clean it finds nothing.
//
// Dry-run by default — prints the count and the per-artist breakdown. `--apply` captures a full
// rollback JSON, deletes, and re-counts.
//
//   bun run packages/skills/fluncle-catalogue-prune/scripts/clean-orphan-edges.ts [--apply]
//
// Run from the REPO ROOT with prod creds (see lib.ts / SKILL.md § Setup).
import { writeFileSync } from "node:fs";

import { type Client } from "@libsql/client/web";

import {
  ORPHAN_EDGE_BY_ARTIST_SQL,
  ORPHAN_EDGE_COUNT_SQL,
  ORPHAN_EDGE_DELETE_SQL,
  ORPHAN_EDGE_ROWS_SQL,
  getDb,
} from "./lib";

export type OrphanByArtist = { artist_id: string; name: string; slug: string; edges: number };

/** A libSQL cell is a union (text/blob/number/null); take it as text only when it IS text. */
const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** How many `track_artists` rows point at a track that no longer exists. */
export async function countOrphanEdges(db: Client): Promise<number> {
  const result = await db.execute(ORPHAN_EDGE_COUNT_SQL);

  return Number(result.rows[0]?.n ?? 0);
}

/** The same orphans, grouped by the artist still holding them — heaviest first. */
export async function orphanEdgesByArtist(db: Client): Promise<OrphanByArtist[]> {
  const result = await db.execute(ORPHAN_EDGE_BY_ARTIST_SQL);

  return result.rows.map((r) => ({
    artist_id: text(r.artist_id),
    edges: Number(r.edges ?? 0),
    name: text(r.name),
    slug: text(r.slug),
  }));
}

/** The full orphaned rows, for the rollback snapshot. */
export async function orphanEdgeRows(db: Client): Promise<unknown[]> {
  return (await db.execute(ORPHAN_EDGE_ROWS_SQL)).rows;
}

/** Delete every orphaned edge. Returns the rows removed. */
export async function deleteOrphanEdges(db: Client): Promise<number> {
  return Number((await db.execute(ORPHAN_EDGE_DELETE_SQL)).rowsAffected);
}

export async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const out = process.env.PRUNE_OUT_DIR ?? ".";
  const db = await getDb();

  const before = await countOrphanEdges(db);
  const byArtist = await orphanEdgesByArtist(db);

  console.log(`\n===== ORPHAN EDGES (${apply ? "APPLY" : "DRY RUN"}) =====`);
  console.log(`orphaned track_artists rows: ${before} · artists holding them: ${byArtist.length}`);
  for (const a of byArtist) {
    console.log(`  ${a.edges.toString().padStart(4)} · ${a.name}${a.slug ? `  (${a.slug})` : ""}`);
  }

  if (before === 0) {
    console.log(`\nNothing to clean — every edge points at a live track.`);

    return;
  }

  if (!apply) {
    console.log(`\nDRY RUN — nothing written. Re-run with --apply to delete them.`);

    return;
  }

  const rows = await orphanEdgeRows(db);
  const path = `${out}/orphan-edges-rollback.json`;
  writeFileSync(
    path,
    JSON.stringify({ at: new Date().toISOString(), track_artists: rows }, null, 2),
  );
  console.log(`\nrollback → ${path} (${rows.length} rows)`);

  const deleted = await deleteOrphanEdges(db);
  const after = await countOrphanEdges(db);

  console.log(`before ${before} · deleted ${deleted} · after ${after}`);
  console.log(
    after === 0
      ? `DONE. Rollback: ${path}`
      : `WARNING — ${after} orphans remain. Re-run; if the number holds, something is writing them.`,
  );
  // HUB COUNTS: an orphaned edge never counted toward `renderable_track_count` in the first place
  // (the reconcile sweep's artists source joins `tracks`), so this cleanup moves no counter. The
  // PURGE does — see the note at the end of purge.ts.
}

if (import.meta.main) {
  await main();
}
