#!/usr/bin/env bun
// TARGETED artist purge — the namesake repair. Takes an EXPLICIT artist list and deletes exactly
// those artists, the tracks credited ONLY to them, orphaned albums, and the same cascade `purge.ts`
// runs (edges, socials, aliases, centroids/similar, cost_events). Full per-row rollback first.
//
//   bun run packages/skills/fluncle-catalogue-prune/scripts/purge-artists.ts --artists "slug-a|slug-b"
//   bun run packages/skills/fluncle-catalogue-prune/scripts/purge-artists.ts --artists-file list.txt --confirm
//
// WHY IT EXISTS. `purge.ts` is LABEL-DRIVEN: an artist is purgeable because a label the operator
// DISABLED is behind them. That cannot express the namesake case — the crawler's seed resolver
// picked the wrong same-named MusicBrainz label under a seed the operator CORRECTLY enabled, so
// the label ruling is right and the tracks under it belong to an impostor. No label-level signal
// separates them; only a human naming the wrong artists does. See SKILL.md § Namesake repair.
//
// SO THIS TOOL DELETES TRACKS ON ENABLED LABELS. That is the point, and it is why the dry-run
// prints the label breakdown with each label's seed state: you are meant to see "yes, these sit
// under an enabled seed, and yes, they are the other band's".
//
// THE RAILS, all hard aborts rather than skips — a refusal means the operator's list is wrong:
//   - a named slug with no `artists` row
//   - a named artist carrying a `findings` track (Maurice's real work; the KEEP rule in lib.ts)
//   - any deletable track entangled in a mixtape / save / post / frontier edition
// And the shared-credit survival rule: a track credited to an artist you did NOT name survives.
//
// Dry-run by default; --confirm writes. TAKE A FRESH BACKUP FIRST (see SKILL.md).
import { readFileSync, writeFileSync } from "node:fs";

import {
  CASCADE_TRACK_TABLES,
  type Catalogue,
  captureArtistCascadeRollback,
  countTrackRefs,
  deleteArtistCascade,
  entanglementHits,
  labelsByArtist,
  loadCatalogue,
  orphanAlbums,
  resolveNamedArtists,
  slugify,
  trackArtistIndex,
  tracksCreditedOnlyTo,
} from "./lib";

/** Pipe-separated list arg, e.g. `--artists "slug-a|slug-b"`. */
export function listArg(argv: string[], flag: string): string[] {
  const i = argv.indexOf(flag);
  const raw = i >= 0 ? argv[i + 1] : undefined;

  return raw
    ? raw
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

/** One slug per line; `#` starts a comment so a hand-kept list can carry its reasoning. */
export function parseArtistsFile(contents: string): string[] {
  return contents
    .split("\n")
    .map((line) => line.split("#")[0]?.trim() ?? "")
    .filter(Boolean);
}

export type PurgeArtistsPlan = {
  albumIds: string[];
  artistIds: string[];
  /** Per named artist, the tracks that STAY because an artist outside the list is credited too. */
  survivors: Map<string, string[]>;
  trackIds: string[];
};

/** What the named set costs: which tracks and albums go, and which tracks are held back. */
export function planNamedArtistPurge(
  cat: Catalogue,
  artistIds: ReadonlySet<string>,
): PurgeArtistsPlan {
  const index = trackArtistIndex(cat);
  const deletable = tracksCreditedOnlyTo(cat, artistIds, index);
  const survivors = new Map<string, string[]>();
  for (const e of cat.edges) {
    if (artistIds.has(e.artist_id) && !deletable.has(e.track_id)) {
      const kept = survivors.get(e.artist_id) ?? [];
      kept.push(e.track_id);
      survivors.set(e.artist_id, kept);
    }
  }

  return {
    albumIds: [...orphanAlbums(cat, deletable)],
    artistIds: [...artistIds],
    survivors,
    trackIds: [...deletable],
  };
}

/** How the operator's label rulings read the raw `tracks.label` string this track carries. */
function seedState(cat: Catalogue, label: string): string {
  const slug = slugify(label);
  if (cat.enabledSlugs.has(slug)) {
    return "enabled seed";
  }

  return cat.disabledSlugs.has(slug) ? "disabled" : "undecided / unruled";
}

async function reportNamedPurge(
  cat: Catalogue,
  resolved: ReturnType<typeof resolveNamedArtists>,
  named: Set<string>,
  plan: PurgeArtistsPlan,
): Promise<boolean> {
  const { albumIds, artistIds, survivors, trackIds } = plan;
  const deletable = new Set(trackIds);
  console.log(
    `artists ${artistIds.length} · tracks ${trackIds.length} · albums ${albumIds.length}`,
  );

  const artistLabels = labelsByArtist(cat, named);
  const perArtistTracks = new Map<string, number>();
  for (const edge of cat.edges) {
    if (deletable.has(edge.track_id) && named.has(edge.artist_id)) {
      perArtistTracks.set(edge.artist_id, (perArtistTracks.get(edge.artist_id) ?? 0) + 1);
    }
  }
  console.log(`\nartists that would be deleted (every one must be the WRONG namesake):`);
  for (const artist of resolved.found) {
    const labels = [...(artistLabels.get(artist.id) ?? [])].slice(0, 6).join(", ") || "(no label)";
    console.log(
      `  ${artist.name}  (${artist.slug})  ·  ${perArtistTracks.get(artist.id) ?? 0} tracks`,
    );
    console.log(`      labels: ${labels}`);
  }

  const labelCounts = new Map<string, number>();
  for (const id of trackIds) {
    const label = cat.trackById.get(id)?.label ?? "(no label)";
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  console.log(`\nlabels the deleted tracks sit on:`);
  for (const [label, count] of [...labelCounts].sort((left, right) => right[1] - left[1])) {
    console.log(`  ${String(count).padStart(5)} · ${label}  [${seedState(cat, label)}]`);
  }

  console.log(`\ntracks that SURVIVE (shared credit with an artist you did not name):`);
  if (survivors.size === 0) {
    console.log(`  (none — every track of every named artist is credited to named artists only)`);
  }
  const index = trackArtistIndex(cat);
  for (const artist of resolved.found) {
    const kept = survivors.get(artist.id) ?? [];
    if (kept.length === 0) {
      continue;
    }
    console.log(`  ${artist.name} keeps ${kept.length}:`);
    for (const id of kept) {
      const title = cat.trackById.get(id)?.title ?? "(untitled)";
      const others = [...(index.get(id) ?? [])]
        .filter((other) => !named.has(other))
        .map((other) => cat.artistById.get(other)?.name ?? other)
        .join(", ");
      console.log(`      "${title}"  ·  also credited to ${others || "(nobody)"}`);
    }
  }

  const tripped = await entanglementHits(cat.db, deletable);
  for (const { hits, table } of tripped) {
    console.log(`  ⚠ ENTANGLEMENT: ${table} has ${hits} of the deletable tracks`);
  }
  if (tripped.length > 0) {
    console.log(
      `\nABORTED — a deletable track is entangled in a real object (mixtape/save/post/edition).`,
    );
    console.log(`Investigate those track_ids by hand; do not purge until resolved.`);
    return false;
  }
  console.log(`\nentanglement guard: clean (nothing in mixtapes / saves / posts / editions)`);
  for (const table of CASCADE_TRACK_TABLES) {
    console.log(`  cascade ${table}: ${await countTrackRefs(cat.db, table, deletable)} rows`);
  }
  return true;
}

export async function main(
  argv: string[] = process.argv.slice(2),
  load: () => Promise<Catalogue> = loadCatalogue,
): Promise<number> {
  const confirm = argv.includes("--confirm");
  const out = process.env.PRUNE_OUT_DIR ?? ".";

  const fileIndex = argv.indexOf("--artists-file");
  const filePath = fileIndex >= 0 ? argv[fileIndex + 1] : undefined;
  const slugs = [
    ...new Set([
      ...listArg(argv, "--artists"),
      ...(filePath ? parseArtistsFile(readFileSync(filePath, "utf8")) : []),
    ]),
  ];

  if (slugs.length === 0) {
    console.log(
      "Nothing to do. Pass --artists with pipe-separated slugs and/or --artists-file <path>.",
    );

    return 0;
  }

  const cat = await load();
  const db = cat.db;
  const resolved = resolveNamedArtists(cat, slugs);

  console.log(`\n===== TARGETED ARTIST PURGE (${confirm ? "WRITE" : "DRY RUN"}) =====`);
  console.log(`named ${slugs.length} · resolved ${resolved.found.length}`);

  if (resolved.unknownSlugs.length > 0) {
    console.log(`\n  ⚠ no artists row for: ${resolved.unknownSlugs.join(", ")}`);
    console.log(
      `\nABORTED — every named slug must resolve. Fix the list (a typo, or already purged) and re-run.`,
    );

    return 1;
  }

  if (resolved.withFindings.length > 0) {
    for (const a of resolved.withFindings) {
      console.log(`  ⚠ FINDING: ${a.name} (${a.slug}) has ${a.trackIds.length} findings track(s)`);
    }
    console.log(
      `\nABORTED — a named artist carries a findings row. That is Maurice's logged work, never a namesake.`,
    );
    console.log(`Drop them from the list and re-run.`);

    return 1;
  }

  const named = new Set(resolved.found.map((a) => a.id));
  const plan = planNamedArtistPurge(cat, named);
  if (!(await reportNamedPurge(cat, resolved, named, plan))) {
    return 1;
  }

  const { albumIds, artistIds, trackIds } = plan;

  if (!confirm) {
    console.log(`\nDRY RUN — nothing written. Take a fresh backup, then re-run with --confirm.`);

    return 0;
  }

  // ── rollback (select * of everything, BEFORE deleting) ────────────────────────────────────
  const rollback = await captureArtistCascadeRollback(db, artistIds, trackIds, albumIds);
  const path = `${out}/purge-artists-rollback.json`;
  writeFileSync(path, JSON.stringify(rollback, null, 2));
  console.log(
    `\nrollback → ${path} (artists ${rollback.artists.length}, tracks ${rollback.tracks.length})`,
  );

  await deleteArtistCascade(db, artistIds, trackIds, albumIds);
  console.log(`\nDONE. Rollback: ${path}`);
  // HUB COUNTS lag exactly as they do after purge.ts — the nightly `reconcile_hub_counts` sweep
  // recomputes them from truth within a day. See the note at the end of purge.ts.

  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
