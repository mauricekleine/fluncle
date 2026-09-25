#!/usr/bin/env bun

import { writeFileSync } from "node:fs";

import { type Client, type Row, type Value } from "@libsql/client/web";

import {
  ORPHAN_EDGE_BY_ARTIST_SQL,
  ORPHAN_EDGE_COUNT_SQL,
  ORPHAN_EDGE_DELETE_SQL,
  ORPHAN_EDGE_ROWS_SQL,
  getDb,
} from "./lib";

export type OrphanByArtist = { artist_id: string; name: string; slug: string; edges: number };

const text = (v: Value): string => (typeof v === "string" ? v : "");

export async function countOrphanEdges(db: Client): Promise<number> {
  const result = await db.execute(ORPHAN_EDGE_COUNT_SQL);

  return Number(result.rows[0]?.n ?? 0);
}

export async function orphanEdgesByArtist(db: Client): Promise<OrphanByArtist[]> {
  const result = await db.execute(ORPHAN_EDGE_BY_ARTIST_SQL);

  return result.rows.map((r) => ({
    artist_id: text(r.artist_id),
    edges: Number(r.edges ?? 0),
    name: text(r.name),
    slug: text(r.slug),
  }));
}

export async function orphanEdgeRows(db: Client): Promise<Row[]> {
  return (await db.execute(ORPHAN_EDGE_ROWS_SQL)).rows;
}

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
}

if (import.meta.main) {
  await main();
}
