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
//
// The artist set here is derived from LABEL RULINGS. When the ruling is right and the tracks under
// it belong to a same-named impostor, use `purge-artists.ts` instead — same cascade, artist set
// typed by the operator.
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
// tracks credited ONLY to safe-purge artists (protect any shared/collab track) and not a finding
const deletable = tracksCreditedOnlyTo(cat, safe, trackArtistIndex(cat));
// orphan albums: every one of the album's tracks is deletable
const orphanAlbumIds = orphanAlbums(cat, deletable);

const A = [...safe],
  T = [...deletable],
  AL = [...orphanAlbumIds];
console.log(`\n===== PURGE (${CONFIRM ? "WRITE" : "DRY RUN"}) =====`);
console.log(`artists ${A.length} · tracks ${T.length} · orphan albums ${AL.length}`);

// EYEBALL: name every artist that would be deleted + the labels their tracks sit on. Safe-purge
// artists can be behind ALREADY-disabled labels (invisible in the scan), so this is the only place
// you see WHO gets purged before writing. Every one should be recognisably off-genre.
const purgeLabels = labelsByArtist(cat, safe);
console.log(`\nartists that would be deleted (all should be off-genre):`);
for (const id of A) {
  const name = cat.artistById.get(id)?.name ?? "?";
  const labels = [...(purgeLabels.get(id) ?? [])].slice(0, 4).join(", ") || "(no label)";
  console.log(`  ${name}  ·  ${labels}`);
}

// ── entanglement guard ──────────────────────────────────────────────────────────
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

// ── rollback (select * of everything, BEFORE deleting) ──────────────────────────
const rollback = await captureArtistCascadeRollback(db, A, T, AL);
writeFileSync(`${OUT}/purge-rollback.json`, JSON.stringify(rollback, null, 2));
console.log(
  `\nrollback → ${OUT}/purge-rollback.json (artists ${rollback.artists.length}, tracks ${rollback.tracks.length})`,
);

// ── delete, FK-safe order (children → parents) ──────────────────────────────────
await deleteArtistCascade(db, A, T, AL);
console.log(`\nDONE. Rollback: ${OUT}/purge-rollback.json`);
// HUB COUNTS: this purge runs OUT OF BAND, straight against prod, so the maintained
// `renderable_track_count` / `certified_finding_count` on artists/labels/albums now overstate the
// truth. That is a KNOWN and DESIGNED-FOR drift class: the nightly `reconcile_hub_counts` sweep
// recomputes those counters from truth and rewrites only the rows that disagree, so they self-heal
// within a day (docs/agents/hermes/reconcile-hub-counts-timer/README.md names this skill as one of
// the three drift sources). Deliberately NOT wired into this script — a destructive tool stays
// simple, and the sweep owns that drift.
