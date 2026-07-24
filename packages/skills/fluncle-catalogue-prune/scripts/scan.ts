#!/usr/bin/env bun
// READ-ONLY scan. Surfaces everything an operator needs to run a pruning pass:
//   1. Artist buckets (keep vs safe-purge) + the headline count.
//   2. Off-boundary labels (non-enabled labels behind off-genre artists) to RULE — with sample
//      artists so you classify by NAME. (There is deliberately NO auto genre-classifier here;
//      every automatic signal we tried over-prunes — see references/traps.md.)
//   3. The original-of-remix RESIDUAL: protected artists (≤3 enabled tracks) with a large
//      off-label back-catalogue — the ones a purge can't touch and a human must judge.
// Writes nothing. Run this first, and after every label ruling, to see the effect.
import { aggregateArtists, loadCatalogue, safePurgeArtists, slugify } from "./lib";

const cat = await loadCatalogue();
const agg = aggregateArtists(cat);
const safe = safePurgeArtists(cat, agg);

// ── 1. buckets ──────────────────────────────────────────────────────────────────
let keepFinding = 0,
  keepEnabled = 0;
for (const [, a] of agg) {
  if (a.hasFinding) {
    keepFinding++;
  } else if (a.enabled > 0) {
    keepEnabled++;
  }
}
console.log(`\n===== SCAN =====`);
console.log(`enabled labels: ${cat.enabledSlugs.size} · disabled: ${cat.disabledSlugs.size}`);
console.log(`artists with catalogue tracks: ${agg.size}`);
console.log(`  keep (has finding)          : ${keepFinding}`);
console.log(`  keep (has enabled track)    : ${keepEnabled}`);
console.log(`  SAFE-PURGE (no finding, no enabled track): ${safe.size}`);

// ── 2. off-boundary labels to rule ──────────────────────────────────────────────
// The non-enabled labels behind the safe-purge artists. Disabling the off-genre ones (and
// enabling any real DnB ones) is what makes the purge clean. Classify by NAME, not by the
// roster overlap — DnB acts cross onto majors/EDM, so overlap is a false signal.
type L = { name: string; state: string; tracks: number; artists: Set<string>; sample: Set<string> };
const byLabel = new Map<string, L>();
for (const e of cat.edges) {
  if (!safe.has(e.artist_id) || cat.findingTrackIds.has(e.track_id)) {
    continue;
  }
  const t = cat.trackById.get(e.track_id);
  if (!t || cat.trackEnabled(t) || !t.label) {
    continue;
  }
  const lab = cat.labels.find((l) => l.slug === slugify(t.label));
  if (!lab || lab.seed_state === "enabled") {
    continue;
  }
  let L = byLabel.get(lab.id);
  if (!L) {
    byLabel.set(
      lab.id,
      (L = {
        artists: new Set(),
        name: lab.name,
        sample: new Set(),
        state: lab.seed_state,
        tracks: 0,
      }),
    );
  }
  L.tracks++;
  L.artists.add(e.artist_id);
  if (L.sample.size < 4) {
    L.sample.add(cat.artistById.get(e.artist_id)?.name ?? "?");
  }
}
const undecided = [...byLabel.values()]
  .filter((l) => l.state === "undecided")
  .sort((a, b) => b.tracks - a.tracks);
console.log(`\n--- OFF-BOUNDARY labels behind safe-purge artists (rule these) ---`);
console.log(
  `(already-disabled labels omitted; ${undecided.length} still UNDECIDED shown, biggest first)`,
);
for (const l of undecided.slice(0, 60)) {
  console.log(
    `  ${l.name.slice(0, 34).padEnd(35)} t${String(l.tracks).padStart(4)} a${String(l.artists.size).padStart(3)}  [${[...l.sample].join(", ")}]`,
  );
}

// ── 3. original-of-remix residual ───────────────────────────────────────────────
// Protected artists (survive the purge on a token enabled track) whose catalogue is dominated
// by off-genre. MusicBrainz bills a remix to the ORIGINAL artist, so a DnB remix of a pop/reggae
// song mints a page for the non-DnB original. These need a HUMAN: strip their off-genre tracks
// but keep the DnB remix. The DnB remix often lives on a multi-genre DISABLED label
// (fabric/StreetBeat/…) — so do NOT blanket-strip by disabled label; eyeball each.
const remixish: {
  name: string;
  en: number;
  off: number;
  offLabels: Set<string>;
  titles: string[];
}[] = [];
for (const [id, a] of agg) {
  if (a.hasFinding || a.enabled < 1 || a.enabled > 3 || a.off <= a.enabled) {
    continue;
  }
  const off = new Set<string>(),
    titles: string[] = [];
  for (const e of cat.edges) {
    if (e.artist_id !== id) {
      continue;
    }
    const t = cat.trackById.get(e.track_id);
    if (t && !cat.trackEnabled(t) && !cat.findingTrackIds.has(e.track_id)) {
      if (t.label) {
        off.add(t.label);
      }
      if (titles.length < 3 && t.title) {
        titles.push(`${t.title} · ${t.label ?? "?"}`);
      }
    }
  }
  remixish.push({
    en: a.enabled,
    name: cat.artistById.get(id)?.name ?? "?",
    off: a.off,
    offLabels: off,
    titles,
  });
}
remixish.sort((x, y) => y.off - x.off);
console.log(`\n--- ORIGINAL-OF-REMIX residual (${remixish.length}) — human strip-and-spare ---`);
for (const r of remixish.slice(0, 40)) {
  console.log(
    `  ${r.name}  [en${r.en}/off${r.off}]  off-labels: ${[...r.offLabels].slice(0, 5).join(", ")}`,
  );
  for (const t of r.titles) {
    console.log(`     ${t}`);
  }
}
