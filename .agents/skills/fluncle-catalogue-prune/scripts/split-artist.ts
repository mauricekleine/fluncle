#!/usr/bin/env bun
// THE CONFLATION REPAIR — separate two real-world acts that share ONE `artists` row.
//
//   # SPLIT: the impostor act keeps its tracks, on a NEW artists row of its own
//   bun run packages/skills/fluncle-catalogue-prune/scripts/split-artist.ts \
//     --artist k --labels "cutting-edge" --into "K." --into-mbid <mb-artist-id>
//
//   # STRIP: the impostor tracks are junk on a drum & bass archive — delete them
//   bun run …/split-artist.ts --artist the-kaleidoscope --labels "cutting-edge" --strip
//
//   # …then re-run with --confirm. Dry-run by default. TAKE A FRESH BACKUP FIRST (SKILL.md § 3).
//
// WHY IT EXISTS. `purge-artists.ts` deletes an artist WHOLE. That is right for a pure namesake and
// wrong for a CONFLATED row, where one `artists` row holds a drum & bass act AND an unrelated act of
// the same name: deleting it takes the real act's page with it. `find-conflated-artists.ts` finds
// these; this repairs one, per the operator's ruling, in the only two shapes that are honest:
//
//   SPLIT — mint a new `artists` row for the other act and RE-POINT its `track_artists` edges to it.
//     No track is deleted. Use it when the other act is a real act worth keeping as its own page,
//     or when you simply do not want to destroy data to fix an identity mistake. Reversible.
//   STRIP — delete the impostor tracks outright, through the SAME cascade both purges use
//     (`deleteTracksWithEdges` + the entanglement guard + a full per-row rollback). Use it when the
//     other act's catalogue has no business on a drum & bass archive at all.
//
// THE RAILS, all hard aborts rather than skips — a refusal means the ruling is wrong:
//   - the named artist slug must resolve to an `artists` row;
//   - the artist must have tracks on BOTH sides (otherwise this is a whole-artist case for
//     `purge-artists.ts`, not a split — refusing here stops a mis-typed label emptying a page);
//   - a FINDING on the impostor side aborts (Maurice's logged work is never an impostor);
//   - a SHARED track — credited to an artist outside this repair — is never moved or deleted;
//   - STRIP additionally runs the entanglement guard (mixtape / save / post / edition).
import { writeFileSync } from "node:fs";

import { type Client } from "@libsql/client/web";

import {
  CASCADE_TRACK_TABLES,
  captureArtistCascadeRollback,
  chunk,
  countTrackRefs,
  deleteTracksWithEdges,
  entanglementHits,
  getOrSet,
  orphanAlbums,
  slugify,
  type Catalogue,
  loadCatalogue,
} from "./lib";

export type SplitMode = "split" | "strip";

export type SplitPlan = {
  /** Albums left with no tracks at all by a STRIP — deleted with them. */
  albumIds: string[];
  /** Tracks on the impostor side credited ONLY to this artist: movable (split) or deletable (strip). */
  impostorTrackIds: string[];
  /** Tracks the artist keeps either way. */
  keptTrackIds: string[];
  /** Impostor-side tracks held back because another artist is credited too. */
  sharedTrackIds: string[];
};

/**
 * Which of an artist's tracks sit on the impostor labels, and which of those this repair may touch.
 *
 * The SHARED-CREDIT rule is `purge-artists.ts`'s, applied to a narrower set: a track credited to an
 * artist outside this repair is neither moved nor deleted, because re-pointing it would silently
 * change what the co-artist's page shows. Findings are excluded from the movable set by
 * construction here as well as by the abort below — belt and braces, as in both purges.
 */
export function planSplit(
  cat: Catalogue,
  artistId: string,
  impostorLabelSlugs: ReadonlySet<string>,
): SplitPlan {
  const creditedBy = new Map<string, Set<string>>();

  for (const edge of cat.edges) {
    getOrSet(creditedBy, edge.track_id, () => new Set<string>()).add(edge.artist_id);
  }

  const impostorTrackIds: string[] = [];
  const keptTrackIds: string[] = [];
  const sharedTrackIds: string[] = [];

  for (const edge of cat.edges) {
    if (edge.artist_id !== artistId) {
      continue;
    }

    const track = cat.trackById.get(edge.track_id);

    if (!track) {
      continue;
    }

    const onImpostorLabel = impostorLabelSlugs.has(slugify(track.label));

    if (!onImpostorLabel || cat.findingTrackIds.has(track.track_id)) {
      keptTrackIds.push(track.track_id);
      continue;
    }

    const credited = creditedBy.get(track.track_id) ?? new Set<string>();

    if (credited.size > 1) {
      sharedTrackIds.push(track.track_id);
      keptTrackIds.push(track.track_id);
      continue;
    }

    impostorTrackIds.push(track.track_id);
  }

  return {
    albumIds: [...orphanAlbums(cat, new Set(impostorTrackIds))],
    impostorTrackIds,
    keptTrackIds,
    sharedTrackIds,
  };
}

/** A slug nothing else holds — the `-2`, `-3`, … salt `mintArtistSlug` uses on the server. */
export function mintSlug(base: string, taken: ReadonlySet<string>): string {
  const root = slugify(base) || "artist";

  if (!taken.has(root)) {
    return root;
  }

  for (let i = 2; i <= 64; i++) {
    if (!taken.has(`${root}-${i}`)) {
      return `${root}-${i}`;
    }
  }

  throw new Error(`split-artist: no free slug for "${base}" after 64 tries`);
}

/**
 * SPLIT: mint the new artist and re-point the impostor edges onto it, atomically per chunk.
 *
 * The edge move is an UPDATE of `artist_id`, not a delete-then-insert: the `track_artists` primary
 * key is `(track_id, artist_id)`, so an update carries the row's `position` and `role` across
 * untouched, and there is no window where the track has no artist at all.
 */
export async function applySplit(
  db: Client,
  newArtist: { id: string; mbid: null | string; name: string; slug: string },
  fromArtistId: string,
  trackIds: string[],
): Promise<number> {
  const now = new Date().toISOString();
  await db.execute({
    args: [newArtist.id, newArtist.name, newArtist.slug, newArtist.mbid, now, now],
    sql: `insert into artists (id, name, slug, mbid, created_at, updated_at) values (?, ?, ?, ?, ?, ?)`,
  });

  let moved = 0;

  for (const c of chunk(trackIds)) {
    const holes = c.map(() => "?").join(",");
    const result = await db.execute({
      args: [newArtist.id, fromArtistId, ...c],
      sql: `update track_artists set artist_id = ?
             where artist_id = ? and track_id in (${holes})`,
    });
    moved += Number(result.rowsAffected);
  }

  return moved;
}

// ── I/O ──────────────────────────────────────────────────────────────────────────────────────────

const flag = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);

  return i >= 0 ? argv[i + 1] : undefined;
};

const listArg = (argv: string[], name: string): string[] =>
  (flag(argv, name) ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);

const splitMode = (argv: string[]): SplitMode => (argv.includes("--strip") ? "strip" : "split");

async function reportStripPlan(
  db: Client,
  impostorSet: Set<string>,
  albumIds: string[],
): Promise<boolean> {
  const tripped = await entanglementHits(db, impostorSet);

  for (const { hits, table } of tripped) {
    console.log(`  ⚠ ENTANGLEMENT: ${table} has ${hits} of the deletable tracks`);
  }

  if (tripped.length > 0) {
    console.log(
      `\nABORTED — a deletable track is entangled in a real object (mixtape/save/post/edition).`,
    );
    return false;
  }

  console.log(`\nentanglement guard: clean`);

  for (const table of CASCADE_TRACK_TABLES) {
    console.log(`  cascade ${table}: ${await countTrackRefs(db, table, impostorSet)} rows`);
  }

  console.log(`albums orphaned by the strip: ${albumIds.length}`);
  return true;
}

export async function main(
  argv: string[] = process.argv.slice(2),
  load: () => Promise<Catalogue> = loadCatalogue,
  newId: () => string = () => crypto.randomUUID(),
): Promise<number> {
  const confirm = argv.includes("--confirm");
  const mode = splitMode(argv);
  const out = process.env.PRUNE_OUT_DIR ?? ".";
  const slug = flag(argv, "--artist");
  const labelSlugs = new Set(listArg(argv, "--labels").map((s) => slugify(s)));
  const intoName = flag(argv, "--into");
  const intoMbid = flag(argv, "--into-mbid") ?? null;

  if (!slug || labelSlugs.size === 0) {
    console.log(
      `Nothing to do. Pass --artist <slug> and --labels "<impostor-label-slug>|…",` +
        ` plus --into "<new name>" (split) or --strip.`,
    );

    return 0;
  }

  if (mode === "split" && !intoName) {
    console.log(`ABORTED — a split needs --into "<the other act's name>" (or pass --strip).`);

    return 1;
  }

  const cat = await load();
  const db = cat.db;
  const artist = cat.artists.find((a) => a.slug === slug);

  console.log(
    `\n===== CONFLATION REPAIR · ${mode.toUpperCase()} (${confirm ? "WRITE" : "DRY RUN"}) =====`,
  );

  if (!artist) {
    console.log(`\nABORTED — no artists row for "${slug}".`);

    return 1;
  }

  const plan = planSplit(cat, artist.id, labelSlugs);
  console.log(`artist: ${artist.name} (${artist.slug})`);
  console.log(`impostor labels: ${[...labelSlugs].join(", ")}`);
  console.log(
    `impostor-side tracks ${plan.impostorTrackIds.length} · kept ${plan.keptTrackIds.length} · shared (held back) ${plan.sharedTrackIds.length}`,
  );

  if (plan.impostorTrackIds.length === 0) {
    console.log(
      `\nABORTED — nothing on the impostor side. Check the --labels slugs against the detector's output.`,
    );

    return 1;
  }

  // THE CONFLATION RAIL. If the artist keeps NOTHING, this row is not conflated — it is a plain
  // namesake, and deleting the whole artist is `purge-artists.ts`'s job, with its own guards.
  if (plan.keptTrackIds.length === 0) {
    console.log(
      `\nABORTED — this artist has NO tracks outside the impostor labels, so it is not a conflated` +
        ` row. That is a whole-artist namesake: use purge-artists.ts instead.`,
    );

    return 1;
  }

  const impostorSet = new Set(plan.impostorTrackIds);
  const findings = plan.impostorTrackIds.filter((id) => cat.findingTrackIds.has(id));

  if (findings.length > 0) {
    console.log(`\nABORTED — ${findings.length} impostor-side track(s) carry a findings row.`);

    return 1;
  }

  console.log(`\nimpostor-side tracks (each must belong to the OTHER act):`);

  for (const id of plan.impostorTrackIds.slice(0, 25)) {
    const track = cat.trackById.get(id);
    console.log(`  "${track?.title ?? "(untitled)"}"  ·  ${track?.label ?? "(no label)"}`);
  }

  if (plan.impostorTrackIds.length > 25) {
    console.log(`  … and ${plan.impostorTrackIds.length - 25} more`);
  }

  console.log(`\ntracks the artist KEEPS (${plan.keptTrackIds.length}):`);

  for (const id of plan.keptTrackIds.slice(0, 15)) {
    const track = cat.trackById.get(id);
    console.log(`  "${track?.title ?? "(untitled)"}"  ·  ${track?.label ?? "(no label)"}`);
  }

  if (plan.sharedTrackIds.length > 0) {
    console.log(`\nHELD BACK — shared credit with an artist outside this repair:`);

    for (const id of plan.sharedTrackIds) {
      console.log(`  "${cat.trackById.get(id)?.title ?? "(untitled)"}"`);
    }
  }

  if (mode === "strip") {
    if (!(await reportStripPlan(db, impostorSet, plan.albumIds))) {
      return 1;
    }
  } else {
    const taken = new Set(cat.artists.map((a) => a.slug));
    console.log(`\nnew artist row: "${intoName}" → slug ${mintSlug(intoName ?? "", taken)}`);
    console.log(`  mbid: ${intoMbid ?? "(none — pass --into-mbid to make it identity-true)"}`);
  }

  if (!confirm) {
    console.log(`\nDRY RUN — nothing written. Take a fresh backup, then re-run with --confirm.`);

    return 0;
  }

  // ── rollback, captured BEFORE anything changes ───────────────────────────────────────────────
  const rollback = await captureArtistCascadeRollback(
    db,
    [artist.id],
    plan.impostorTrackIds,
    mode === "strip" ? plan.albumIds : [],
  );
  const path = `${out}/split-artist-${artist.slug}-rollback.json`;
  writeFileSync(path, JSON.stringify({ ...rollback, mode }, null, 2));
  console.log(`\nrollback → ${path}`);

  if (mode === "strip") {
    const removed = await deleteTracksWithEdges(db, plan.impostorTrackIds);
    console.log(`  deleted track_artists.track_id: ${removed.edges}`);
    console.log(`  deleted tracks.track_id: ${removed.tracks}`);

    for (const c of chunk(plan.albumIds)) {
      const result = await db.execute({
        args: c,
        sql: `delete from albums where id in (${c.map(() => "?").join(",")})`,
      });
      console.log(`  deleted albums: ${Number(result.rowsAffected)}`);
    }
  } else {
    const taken = new Set(cat.artists.map((a) => a.slug));
    const moved = await applySplit(
      db,
      {
        id: newId(),
        mbid: intoMbid,
        name: intoName ?? "",
        slug: mintSlug(intoName ?? "", taken),
      },
      artist.id,
      plan.impostorTrackIds,
    );
    console.log(`  moved track_artists edges: ${moved}`);
  }

  console.log(`\nDONE. Rollback: ${path}`);
  // HUB COUNTS lag exactly as they do after either purge — the nightly `reconcile_hub_counts` sweep
  // recomputes them from truth within a day. See the note at the end of purge.ts.

  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
