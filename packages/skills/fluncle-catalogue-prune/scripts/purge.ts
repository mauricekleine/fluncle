#!/usr/bin/env bun

import { writeFileSync } from "node:fs";
import {
  CASCADE_TRACK_TABLES,
  captureArtistCascadeRollback,
  countTrackRefs,
  deleteArtistCascade,
  entanglementHits,
  labelsByArtist,
  loadCatalogue,
  orphanAlbums,
  safePurgeArtists,
  trackArtistIndex,
  tracksCreditedOnlyTo,
} from "./lib";

const CONFIRM = process.argv.includes("--confirm");
const OUT = process.env.PRUNE_OUT_DIR ?? ".";
const cat = await loadCatalogue();
const db = cat.db;

const safe = safePurgeArtists(cat);

const deletable = tracksCreditedOnlyTo(cat, safe, trackArtistIndex(cat));

const orphanAlbumIds = orphanAlbums(cat, deletable);

const A = [...safe],
  T = [...deletable],
  AL = [...orphanAlbumIds];
console.log(`\n===== PURGE (${CONFIRM ? "WRITE" : "DRY RUN"}) =====`);
console.log(`artists ${A.length} · tracks ${T.length} · orphan albums ${AL.length}`);

const purgeLabels = labelsByArtist(cat, safe);
console.log(`\nartists that would be deleted (all should be off-genre):`);
for (const id of A) {
  const name = cat.artistById.get(id)?.name ?? "?";
  const labels = [...(purgeLabels.get(id) ?? [])].slice(0, 4).join(", ") || "(no label)";
  console.log(`  ${name}  ·  ${labels}`);
}

const tripped = await entanglementHits(db, deletable);
for (const { hits, table } of tripped) {
  console.log(`  ⚠ ENTANGLEMENT: ${table} has ${hits} of the deletable tracks`);
}
if (tripped.length > 0) {
  console.log(
    `\nABORTED — a deletable track is entangled in a real object (mixtape/save/post/edition).`,
  );
  console.log(`Investigate those track_ids by hand; do not purge until resolved.`);
  process.exit(1);
}
console.log(`entanglement guard: clean (nothing in mixtapes / saves / posts / editions)`);
for (const t of CASCADE_TRACK_TABLES) {
  console.log(`  cascade ${t}: ${await countTrackRefs(db, t, deletable)} rows`);
}

if (!CONFIRM) {
  console.log(`\nDRY RUN — nothing written. Take a fresh backup, then re-run with --confirm.`);
  process.exit(0);
}

const rollback = await captureArtistCascadeRollback(db, A, T, AL);
writeFileSync(`${OUT}/purge-rollback.json`, JSON.stringify(rollback, null, 2));
console.log(
  `\nrollback → ${OUT}/purge-rollback.json (artists ${rollback.artists.length}, tracks ${rollback.tracks.length})`,
);

await deleteArtistCascade(db, A, T, AL);
console.log(`\nDONE. Rollback: ${OUT}/purge-rollback.json`);
