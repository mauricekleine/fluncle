#!/usr/bin/env bun
// Artist-driven off-genre purge. Deletes SAFE-PURGE artists (no finding, no enabled-label track),
// the tracks credited ONLY to them, orphaned albums, and the full cascade (edges, socials, aliases,
// centroids/similar, cost_events). Writes a full per-row rollback BEFORE deleting.
//
// Dry-run by default; --confirm writes. TAKE A FRESH BACKUP FIRST (see SKILL.md).
//
// ENTANGLEMENT GUARD: if any deletable track is in a mixtape, a user save, a published post, or a
// frontier edition, the run ABORTS and reports it — an off-genre track showing up there is a
// surprise a human must resolve, never a silent delete.
import { writeFileSync } from "node:fs";
import { chunk, getOrSet, loadCatalogue, safePurgeArtists } from "./lib";

const CONFIRM = process.argv.includes("--confirm");
const OUT = process.env.PRUNE_OUT_DIR ?? ".";
const cat = await loadCatalogue();
const db = cat.db;
const rows = async (sql: string) => (await db.execute(sql)).rows as any[];

const safe = safePurgeArtists(cat);
// tracks credited ONLY to safe-purge artists (protect any shared/collab track) and not a finding
const trackArtists = new Map<string, Set<string>>();
for (const e of cat.edges) {
  getOrSet(trackArtists, e.track_id, () => new Set<string>()).add(e.artist_id);
}
const deletable = new Set<string>();
for (const [tid, arts] of trackArtists) {
  if (!cat.findingTrackIds.has(tid) && [...arts].every((a) => safe.has(a))) {
    deletable.add(tid);
  }
}
// orphan albums: every one of the album's tracks is deletable
const albumTracks = new Map<string, string[]>();
for (const t of cat.tracks) {
  if (t.album_id) {
    getOrSet(albumTracks, t.album_id, () => [] as string[]).push(t.track_id);
  }
}
const orphanAlbums = new Set<string>();
for (const [aid, tids] of albumTracks) {
  if (tids.every((tid) => deletable.has(tid))) {
    orphanAlbums.add(aid);
  }
}

const A = [...safe],
  T = [...deletable],
  AL = [...orphanAlbums];
console.log(`\n===== PURGE (${CONFIRM ? "WRITE" : "DRY RUN"}) =====`);
console.log(`artists ${A.length} · tracks ${T.length} · orphan albums ${AL.length}`);

// ── entanglement guard ──────────────────────────────────────────────────────────
const T_SET = deletable;
const GUARD = [
  "mixtape_tracks",
  "user_saved_findings",
  "social_posts",
  "social_metrics",
  "frontier_edition_tracks",
  "user_galaxy_collections",
  "user_rec_seeds",
  "note_rejections",
  "observation_rejections",
];
const CASCADE_TRACK = ["cost_events"]; // housekeeping track-refs we simply delete (never real objects)
let tripped = false;
for (const table of GUARD) {
  const hit = (await rows(`select track_id from ${table}`)).filter((r) =>
    T_SET.has(r.track_id),
  ).length;
  if (hit > 0) {
    console.log(`  ⚠ ENTANGLEMENT: ${table} has ${hit} of the deletable tracks`);
    tripped = true;
  }
}
if (tripped) {
  console.log(
    `\nABORTED — a deletable track is entangled in a real object (mixtape/save/post/edition).`,
  );
  console.log(`Investigate those track_ids by hand; do not purge until resolved.`);
  process.exit(1);
}
console.log(`entanglement guard: clean (nothing in mixtapes / saves / posts / editions)`);
for (const t of CASCADE_TRACK) {
  const n = (await rows(`select track_id from ${t}`)).filter((r) => T_SET.has(r.track_id)).length;
  console.log(`  cascade ${t}: ${n} rows`);
}

if (!CONFIRM) {
  console.log(`\nDRY RUN — nothing written. Take a fresh backup, then re-run with --confirm.`);
  process.exit(0);
}

// ── rollback (select * of everything, BEFORE deleting) ──────────────────────────
async function selAll(table: string, col: string, ids: string[]) {
  const out: any[] = [];
  for (const c of chunk(ids)) {
    out.push(
      ...(
        await db.execute({
          args: c,
          sql: `select * from ${table} where ${col} in (${c.map(() => "?").join(",")})`,
        })
      ).rows,
    );
  }
  return out;
}
const rollback = {
  albums: await selAll("albums", "id", AL),
  artist_aliases: await selAll("artist_aliases", "artist_id", A),
  artist_socials: await selAll("artist_socials", "artist_id", A),
  artists: await selAll("artists", "id", A),
  at: new Date().toISOString(),
  cost_events: await selAll("cost_events", "track_id", T),
  track_artists: await selAll("track_artists", "artist_id", A),
  tracks: await selAll("tracks", "track_id", T),
};
writeFileSync(`${OUT}/purge-rollback.json`, JSON.stringify(rollback, null, 2));
console.log(
  `\nrollback → ${OUT}/purge-rollback.json (artists ${rollback.artists.length}, tracks ${rollback.tracks.length})`,
);

// ── delete, FK-safe order (children → parents) ──────────────────────────────────
async function del(table: string, col: string, ids: string[]) {
  let n = 0;
  for (const c of chunk(ids)) {
    n += Number(
      (
        await db.execute({
          args: c,
          sql: `delete from ${table} where ${col} in (${c.map(() => "?").join(",")})`,
        })
      ).rowsAffected,
    );
  }
  console.log(`  deleted ${table}.${col}: ${n}`);
}
await del("cost_events", "track_id", T);
await del("artist_socials", "artist_id", A);
await del("artist_aliases", "artist_id", A);
await del("artist_centroids", "artist_id", A);
await del("artist_similar", "artist_id", A);
await del("artist_similar", "neighbour_artist_id", A);
await del("track_artists", "artist_id", A);
await del("tracks", "track_id", T);
await del("albums", "id", AL);
await del("artists", "id", A);
console.log(`\nDONE. Rollback: ${OUT}/purge-rollback.json`);
