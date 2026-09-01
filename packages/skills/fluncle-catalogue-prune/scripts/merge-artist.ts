#!/usr/bin/env bun
// THE DUPLICATE-ROW MERGE — fold two `artists` rows that are the SAME real-world act into one.
//
//   # MERGE: fold the duplicate row into the canonical one
//   bun run packages/skills/fluncle-catalogue-prune/scripts/merge-artist.ts \
//     --canonical orion --duplicate orion-2 --drop-duplicate-socials
//
//   # REPOINT ONLY: fix a row's identity, no duplicate involved (--duplicate is optional)
//   bun run …/merge-artist.ts --canonical neon --set-mbid 839ec4c2-7d59-4dc9-a966-4f6920ceb7d6
//
//   # …then re-run with --confirm. Dry-run by default. TAKE A FRESH BACKUP FIRST (SKILL.md § 3).
//
// WHY IT EXISTS. `split-artist.ts` is the repair for ONE row holding TWO acts. This is the exact
// inverse: TWO rows holding ONE act. The crawler mints an artist per MusicBrainz identity it walks,
// so a real-world act that MusicBrainz carries under two MBIDs — or that Fluncle met twice before
// an MBID was known — lands as `orion` and `orion-2`: two `/artist` pages, one discography split
// across them, and (usually) at least one row wearing an MBID that belongs to neither side.
//
// WHAT IT DOES, in `mergeLabel`'s shape (apps/web/src/lib/server/labels.ts — the ratified
// precedent this deliberately mirrors statement for statement):
//   - RE-POINTS every reference to the duplicate onto the canonical (see ARTIST_REFERENCES);
//   - RECONCILES identity CANONICAL-WINS, filling an EMPTY canonical slot from the duplicate;
//   - records the duplicate's NAME + SLUG as a `confirmed` operator ALIAS on the canonical, so the
//     merged-away slug can never be re-minted and the fold key survives the row;
//   - moves the maintained hub counts by measured DELTA arithmetic, never a recompute;
//   - DELETES the duplicate `artists` row;
//   - writes a full per-row rollback JSON before any of it.
//
// NO TRACK IS EVER DELETED. A merge only moves credit, so it is reversible from the rollback file.
//
// ── THE FINDINGS RULE (reasoned out, because `findings` does NOT reference `artists`) ────────────
//
// A `findings` row keys on `track_id`, not on an artist. So a merge — which deletes no track and
// only re-points `track_artists` edges — can never orphan or destroy a finding. What it CAN do is
// change which `/artist/<slug>` page a certified finding hangs off, and that is a public claim
// about Maurice's own logged work. So:
//
//   ABORT when the duplicate credits a FINDING-BEARING track that the canonical does NOT already
//   credit. That is a finding MOVING to a different artist page — the merge's premise ("these two
//   rows are one act") is exactly the thing in doubt, and a wrong ruling would re-attribute a
//   logged banger. It is a hard abort, never a skip: a findings hit means the ruling needs a human.
//
//   ALLOW when the canonical ALREADY credits that same finding track. Then the finding INHERITS
//   CLEANLY: both rows sit on the one track, the merge collapses a double credit to a single edge,
//   and the finding's artist page is unchanged. Nothing moves, so there is nothing to rule on.
//
// ── THE RAILS, all hard aborts rather than skips — a refusal means the ruling is wrong ───────────
//   - both slugs must resolve to an `artists` row;
//   - canonical and duplicate must be different rows;
//   - the findings rule above.
import { writeFileSync } from "node:fs";

import { type Client } from "@libsql/client/web";

import { type Catalogue, loadCatalogue } from "./lib";

// ── The reference map: EVERY table that carries an `artists.id` ──────────────────────────────────
//
// THE COMPLETENESS INVARIANT: after a merge, ZERO rows anywhere may still reference the duplicate.
// Miss one table and the merge strands rows pointing at an artist that no longer exists — the
// orphaned-edge bug `clean-orphan-edges.ts` exists to mop up, one table wider.
//
// Enumerated from `apps/web/src/db/schema.ts` and re-verified against the LIVE production schema
// (2026-07-27) by scanning `sqlite_master` for every column matching `%artist%` plus every
// `entity_id` column. That sweep returned exactly the seven references below. The other `%artist%`
// columns it found — `tracks.artists_json`, `submissions.artists_json`, `mixtape_tracks
// .artists_text`, `recording_cues.artists_text`, `frontier_edition_tracks.artists_text`,
// `artists.spotify_artist_id` — are denormalized NAME strings, not id references. A merge folds two
// rows that carry the SAME name, so those strings are already correct and are deliberately untouched.
//
// NONE of these are SQL foreign keys: the live DDL declares no `FOREIGN KEY` clause on any of them
// (verified against production), exactly as `labels` does not. They are logical FKs — plain string
// columns — which is why the duplicate row can be DELETED FIRST (freeing its unique `slug` and
// `spotify_artist_id` before the canonical adopts them) and the re-points still land afterwards.
export type ArtistReference = {
  /** The column carrying the `artists.id` value. */
  column: string;
  /** Extra predicate ANDed onto every statement — the polymorphic `user_watches` case. */
  filter?: string;
  /**
   * `repoint` — the row is a FACT ABOUT THE ACT, so it follows the act onto the canonical.
   * `drop`    — the row is a DERIVED artifact of a nightly sweep. Repointing it would either
   *             collide on a primary key or fabricate a precomputed claim, so it is deleted and
   *             the sweep recomputes it from truth. See the note under DERIVED ARTIFACTS below.
   */
  mode: "drop" | "repoint";
  /** The table holding the reference. */
  table: string;
};

// ── DERIVED ARTIFACTS: why `artist_centroids` / `artist_similar` are dropped, not re-pointed ─────
//
// Both are precomputed outputs of the artist-dossier sweep, and both are UNPOINTABLE by shape:
//   - `artist_centroids.artist_id` is the PRIMARY KEY, so a re-point collides whenever the
//     canonical already has one.
//   - `artist_similar`'s PK is `(artist_id, rank)`, so re-pointing `artist_id` collides on rank;
//     re-pointing `neighbour_artist_id` can put the canonical TWICE in one artist's ranked list, or
//     make the canonical its own neighbour.
// Dropping the duplicate's rows is therefore the only shape that strands nothing and claims nothing
// false. The CANONICAL's own rows are deliberately LEFT ALONE: `rank_corpus` is
// `"<version>:<the artist's live embedded-track count>"`, so if the merge changed which embedded
// tracks the canonical holds, the stored fingerprint disagrees on the sweep's next tick and both
// the centroid and its edges recompute from truth (`STALE_ARTISTS_INNER` in
// apps/web/src/lib/server/artist-dossier.ts). If it did not change, the canonical's centroid is
// still correct and there is nothing to fix. Self-healing either way — so a merge deletes only what
// would otherwise dangle.
export const ARTIST_REFERENCES: ArtistReference[] = [
  // The discography edge. `update or ignore` because the PK is `(track_id, artist_id)`: a track
  // BOTH rows credit would collide, so it is skipped here and swept by the trailing delete — the
  // DOUBLE-EDGE COLLAPSE. That is why the hub-count credit counts only the tracks that actually
  // moved, never the duplicate's raw total.
  { column: "artist_id", mode: "repoint", table: "track_artists" },
  // The act's own channels. Unique on `(artist_id, platform)`, so the same or-ignore + sweep.
  { column: "artist_id", mode: "repoint", table: "artist_socials" },
  // The act's other spellings. Unique on `(artist_id, alias_slug, source)`; same shape.
  { column: "artist_id", mode: "repoint", table: "artist_aliases" },
  { column: "artist_id", mode: "drop", table: "artist_centroids" },
  { column: "artist_id", mode: "drop", table: "artist_similar" },
  { column: "neighbour_artist_id", mode: "drop", table: "artist_similar" },
  // A real person asked to watch this act. Polymorphic (`kind` picks the entity table), so every
  // statement carries the filter — without it a merge would silently re-point a LABEL watch that
  // happens to share the artist's uuid. Unique on `(user_id, kind, entity_id)`: a user watching
  // BOTH rows collapses to one watch rather than duplicating.
  { column: "entity_id", filter: `kind = 'artist'`, mode: "repoint", table: "user_watches" },
];

/** The `where` tail for one reference, including its polymorphic filter when it has one. */
const refWhere = (ref: ArtistReference): string =>
  `${ref.column} = ?${ref.filter ? ` and ${ref.filter}` : ""}`;

export type MergeStatement = { args: (null | number | string)[]; sql: string };

/**
 * The statements that settle ONE reference. Always TWO, and always in this order:
 *
 *   1. a `repoint` first moves what can move (`update or ignore` skips the rows that would collide
 *      with one the canonical already holds — a duplicate credit, channel, alias or watch);
 *   2. a DELETE then sweeps whatever is left pointing at the duplicate.
 *
 * The delete is unconditional and runs for BOTH modes, because it is the completeness invariant
 * made executable: whatever the re-point could not move, and everything a `drop` reference holds,
 * leaves with the row. Nothing can be stranded.
 */
export function referenceStatements(
  ref: ArtistReference,
  canonicalId: string,
  duplicateId: string,
): MergeStatement[] {
  const out: MergeStatement[] = [];

  if (ref.mode === "repoint") {
    out.push({
      args: [canonicalId, duplicateId],
      sql: `update or ignore ${ref.table} set ${ref.column} = ? where ${refWhere(ref)}`,
    });
  }

  out.push({ args: [duplicateId], sql: `delete from ${ref.table} where ${refWhere(ref)}` });

  return out;
}

// ── The plan ────────────────────────────────────────────────────────────────────────────────────

export type MergePlan = {
  /** Tracks BOTH rows credit — the double edge collapses to one, and no credit moves. */
  collapsedTrackIds: string[];
  /** Finding-bearing tracks the canonical does NOT credit yet. Non-empty ⇒ HARD ABORT. */
  findingBlockerTrackIds: string[];
  /** Finding-bearing tracks the canonical ALREADY credits — inherited cleanly, no page changes. */
  findingInheritedTrackIds: string[];
  /** Tracks whose credit genuinely moves from the duplicate to the canonical. */
  movedTrackIds: string[];
};

/**
 * Split the duplicate's discography into what MOVES and what COLLAPSES, and pull out the findings
 * question. Pure — it reads the loaded catalogue and touches no database.
 */
export function planMerge(cat: Catalogue, canonicalId: string, duplicateId: string): MergePlan {
  const canonicalTracks = new Set<string>();
  const duplicateTracks = new Set<string>();

  for (const edge of cat.edges) {
    if (edge.artist_id === canonicalId) {
      canonicalTracks.add(edge.track_id);
    } else if (edge.artist_id === duplicateId) {
      duplicateTracks.add(edge.track_id);
    }
  }

  const collapsedTrackIds: string[] = [];
  const movedTrackIds: string[] = [];

  for (const trackId of duplicateTracks) {
    if (canonicalTracks.has(trackId)) {
      collapsedTrackIds.push(trackId);
    } else {
      movedTrackIds.push(trackId);
    }
  }

  return {
    collapsedTrackIds,
    // A finding that would land on a DIFFERENT artist page: the abort.
    findingBlockerTrackIds: movedTrackIds.filter((id) => cat.findingTrackIds.has(id)),
    // A finding both rows already carry: the merge only collapses a double credit.
    findingInheritedTrackIds: collapsedTrackIds.filter((id) => cat.findingTrackIds.has(id)),
    movedTrackIds,
  };
}

// ── Identity reconciliation: CANONICAL-WINS, fill an EMPTY canonical slot from the duplicate ─────

export type ArtistRow = Record<string, null | number | string>;

/**
 * The single-valued identity columns a merge coalesces. Each is independent: the canonical keeps
 * whatever it has, and only an EMPTY slot is filled from the duplicate — `mergeLabel`'s `take()`.
 *
 * `spotify_artist_id` is UNIQUE and safe to adopt because the duplicate row is deleted in the SAME
 * transaction, one statement earlier.
 */
export const RECONCILED_FIELDS = [
  "mbid",
  "spotify_artist_id",
  "spotify_url",
  "wikidata_qid",
  "discogs_url",
  "lastfm_url",
  "image_url",
  "reviewed_at",
  "resolved_at",
] as const;

/**
 * Columns that must travel TOGETHER or not at all, keyed on the first column being empty on the
 * canonical. Splitting either group would leave a row claiming a state it does not have — a stored
 * `image_key` under a `pending` state gets re-walked by the image sweep; a `bio` without its
 * `bio_status` looks un-authored to the bio sweep and gets re-burned.
 */
export const RECONCILED_GROUPS: { key: string; members: string[] }[] = [
  { key: "image_key", members: ["image_key", "image_source", "image_state", "image_updated_at"] },
  { key: "bio", members: ["bio", "bio_prompt_version", "bio_status"] },
];

export type Reconciliation = {
  /** The column names taken from the duplicate, for the report. */
  filled: string[];
  /** column → value, the `set` clause a merge applies to the canonical. */
  set: ArtistRow;
};

/**
 * Work out what the canonical's row becomes.
 *
 * `setMbid` is the OPERATOR OVERRIDE and outranks everything: it is the whole point of the flag,
 * because the common case is a duplicate pair where NEITHER row's MBID is the act's (a goa-trance
 * artist on one, a UK-garage act on the other). When it CHANGES the canonical's identity it also
 * clears `resolved_at`, which puts the row back on the artist-resolution worklist
 * (`listUnresolvedArtists`: `resolved_at is null`) so the resolver re-walks the NEW MBID and
 * refreshes the socials and KG anchors against it. Repointing an identity without that would leave
 * the old act's channels hanging off the new one forever.
 */
export function reconcile(
  canonical: ArtistRow,
  duplicate: ArtistRow,
  setMbid?: string,
): Reconciliation {
  const set: ArtistRow = {};
  const filled: string[] = [];
  const empty = (v: unknown) => v === null || v === undefined || v === "";

  for (const field of RECONCILED_FIELDS) {
    if (empty(canonical[field]) && !empty(duplicate[field])) {
      set[field] = duplicate[field] ?? null;
      filled.push(field);
    }
  }

  for (const group of RECONCILED_GROUPS) {
    if (empty(canonical[group.key]) && !empty(duplicate[group.key])) {
      for (const member of group.members) {
        set[member] = duplicate[member] ?? null;
      }
      filled.push(`${group.key} (+${group.members.length - 1})`);
    }
  }

  if (setMbid) {
    set.mbid = setMbid;

    if (!filled.includes("mbid")) {
      filled.push("mbid (--set-mbid)");
    }

    if (canonical.mbid !== setMbid) {
      // The identity CHANGED — put the row back on the resolver's worklist. This OUTRANKS a
      // `resolved_at` taken from the duplicate above: that stamp belongs to the old identity.
      set.resolved_at = null;

      return { filled: filled.filter((f) => f !== "resolved_at"), set };
    }
  }

  return { filled, set };
}

// ── I/O ──────────────────────────────────────────────────────────────────────────────────────────

const flag = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);

  return i >= 0 ? argv[i + 1] : undefined;
};

function runHeading(repointOnly: boolean, confirm: boolean): string {
  return `\n===== ${repointOnly ? "IDENTITY REPOINT (no merge)" : "DUPLICATE-ROW MERGE"} (${confirm ? "WRITE" : "DRY RUN"}) =====`;
}

function validateMergeArguments(
  canonicalSlug: string | undefined,
  duplicateSlug: string | undefined,
  setMbid: string | undefined,
): 0 | 1 | undefined {
  if (!canonicalSlug || (!duplicateSlug && !setMbid)) {
    console.log(
      `Nothing to do. Pass --canonical <slug> --duplicate <slug>` +
        ` [--set-mbid <mbid>] [--drop-duplicate-socials] [--confirm],` +
        ` or --canonical <slug> --set-mbid <mbid> alone to repoint an identity without a merge.`,
    );
    return 0;
  }
  if (canonicalSlug === duplicateSlug) {
    console.log(`\nABORTED — --canonical and --duplicate are the same slug ("${canonicalSlug}").`);
    return 1;
  }
  return undefined;
}

function validateResolvedArtists(
  canonical: Catalogue["artists"][number] | undefined,
  canonicalSlug: string,
  duplicate: Catalogue["artists"][number] | undefined,
  duplicateSlug: string | undefined,
  repointOnly: boolean,
): boolean {
  if (!canonical) {
    console.log(`\nABORTED — no artists row for --canonical "${canonicalSlug}".`);
    return false;
  }
  if (!repointOnly && !duplicate) {
    console.log(`\nABORTED — no artists row for --duplicate "${duplicateSlug}".`);
    return false;
  }
  if (duplicate && canonical.id === duplicate.id) {
    console.log(`\nABORTED — both slugs resolve to the same artists row (${canonical.id}).`);
    return false;
  }
  return true;
}

/** `select *` of one reference's rows for the artist — the rollback + the report read this. */
async function selectRefRows(
  db: Client,
  ref: ArtistReference,
  artistId: string,
): Promise<unknown[]> {
  const result = await db.execute({
    args: [artistId],
    sql: `select * from ${ref.table} where ${refWhere(ref)}`,
  });

  return result.rows;
}

function printMergePlan(
  cat: Catalogue,
  canonical: Catalogue["artists"][number],
  duplicate: Catalogue["artists"][number] | undefined,
  plan: MergePlan,
): void {
  console.log(`canonical (SURVIVES): ${canonical.name} (${canonical.slug})  id=${canonical.id}`);

  if (!duplicate) {
    console.log(
      `\nno --duplicate: this run touches IDENTITY ONLY. No edge moves, no row is deleted, and the` +
        ` artist keeps every one of its ${cat.edges.filter((e) => e.artist_id === canonical.id).length} track credit(s).`,
    );
    return;
  }

  console.log(`duplicate (REMOVED):  ${duplicate.name} (${duplicate.slug})  id=${duplicate.id}`);
  console.log(
    `\ntrack credit: ${plan.movedTrackIds.length} moving · ` +
      `${plan.collapsedTrackIds.length} double edge(s) collapsing · 0 tracks deleted (never).`,
  );
  for (const id of plan.movedTrackIds.slice(0, 25)) {
    const track = cat.trackById.get(id);
    console.log(`  MOVE     "${track?.title ?? "(untitled)"}"  ·  ${track?.label ?? "(no label)"}`);
  }
  if (plan.movedTrackIds.length > 25) {
    console.log(`  … and ${plan.movedTrackIds.length - 25} more`);
  }
  for (const id of plan.collapsedTrackIds) {
    const track = cat.trackById.get(id);
    console.log(
      `  COLLAPSE "${track?.title ?? "(untitled)"}"  ·  ${track?.label ?? "(no label)"}` +
        ` (both rows credit it)`,
    );
  }
}

function reportFindingBlocker(cat: Catalogue, plan: MergePlan): boolean {
  if (plan.findingInheritedTrackIds.length > 0) {
    console.log(
      `\nfindings inherited cleanly: ${plan.findingInheritedTrackIds.length}` +
        ` (the canonical already credits them — the page does not change)`,
    );
  }
  if (plan.findingBlockerTrackIds.length === 0) {
    return false;
  }
  console.log(
    `\nABORTED — ${plan.findingBlockerTrackIds.length} finding-bearing track(s) would MOVE to a` +
      ` different artist page, and the canonical does not credit them yet:`,
  );
  for (const id of plan.findingBlockerTrackIds) {
    console.log(`  "${cat.trackById.get(id)?.title ?? "(untitled)"}"  (${id})`);
  }
  console.log(
    `  A finding is Maurice's logged work. Re-attributing one needs a human ruling, not a merge.`,
  );
  return true;
}

function mergeOutputDirectory(): string {
  return process.env.PRUNE_OUT_DIR ?? ".";
}

function findDuplicateArtist(cat: Catalogue, slug: string | undefined) {
  return slug ? cat.artists.find((artist) => artist.slug === slug) : undefined;
}

function referencesForMerge(dropSocials: boolean): ArtistReference[] {
  return ARTIST_REFERENCES.map((ref) =>
    dropSocials && ref.table === "artist_socials" ? { ...ref, mode: "drop" as const } : ref,
  );
}

function mergePlanFor(
  cat: Catalogue,
  canonical: Catalogue["artists"][number],
  duplicate: Catalogue["artists"][number] | undefined,
): MergePlan {
  return duplicate
    ? planMerge(cat, canonical.id, duplicate.id)
    : {
        collapsedTrackIds: [],
        findingBlockerTrackIds: [],
        findingInheritedTrackIds: [],
        movedTrackIds: [],
      };
}

export async function main(
  argv: string[] = process.argv.slice(2),
  load: () => Promise<Catalogue> = loadCatalogue,
  now: () => string = () => new Date().toISOString(),
  newId: () => string = () => crypto.randomUUID(),
): Promise<number> {
  const confirm = argv.includes("--confirm");
  const dropSocials = argv.includes("--drop-duplicate-socials");
  const out = mergeOutputDirectory();
  const canonicalSlug = flag(argv, "--canonical");
  const duplicateSlug = flag(argv, "--duplicate");
  const setMbid = flag(argv, "--set-mbid");

  const argumentExit = validateMergeArguments(canonicalSlug, duplicateSlug, setMbid);
  if (argumentExit !== undefined) {
    return argumentExit;
  }

  // THE SECOND SHAPE. A duplicate pair usually leaves the survivor wearing an MBID that belongs to
  // NEITHER act, so the identity repoint is the merge's other half — and it is just as often needed
  // on a row that has no duplicate at all (a namesake strip leaves the same wound: the right tracks
  // under the wrong act's MBID). Rather than a second tool for the tail of this one, `--duplicate`
  // is optional: without it the run reconciles identity ONLY — no reference is touched, no alias is
  // written, no hub count moves.
  const repointOnly = !duplicateSlug;

  console.log(runHeading(repointOnly, confirm));

  const cat = await load();
  const db = cat.db;
  const canonical = cat.artists.find((a) => a.slug === canonicalSlug);
  const duplicate = findDuplicateArtist(cat, duplicateSlug);

  if (
    !validateResolvedArtists(canonical, canonicalSlug ?? "", duplicate, duplicateSlug, repointOnly)
  ) {
    return 1;
  }

  const plan = mergePlanFor(cat, canonical, duplicate);

  printMergePlan(cat, canonical, duplicate, plan);

  // ── THE FINDINGS RULE (see the header) ────────────────────────────────────────────────────────
  if (reportFindingBlocker(cat, plan)) {
    return 1;
  }

  // ── the reference sweep, its rows read for the report AND the rollback ────────────────────────
  const references = referencesForMerge(dropSocials);
  const duplicateRefRows = new Map<string, unknown[]>();
  const canonicalRefRows = new Map<string, unknown[]>();

  const readReferenceRows = async (): Promise<void> => {
    if (duplicate) {
      console.log(
        `\nreferences to the duplicate row (every one is settled — nothing is stranded):`,
      );

      for (const ref of references) {
        const key = `${ref.table}.${ref.column}`;
        const rows = await selectRefRows(db, ref, duplicate.id);
        duplicateRefRows.set(key, rows);
        canonicalRefRows.set(key, await selectRefRows(db, ref, canonical.id));
        console.log(
          `  ${ref.mode.toUpperCase().padEnd(7)} ${key.padEnd(34)} ${rows.length} row(s)`,
        );
      }
    }
  };

  await readReferenceRows();

  const dupSocials = duplicateRefRows.get("artist_socials.artist_id") ?? [];

  for (const row of dupSocials as { platform?: unknown; url?: unknown }[]) {
    console.log(
      `    ${dropSocials ? "DROP" : "MOVE"} social ${String(row.platform)} ${String(row.url)}`,
    );
  }

  // The identity hazard the flag exists for: MB-sourced channels belong to the MBID that sourced
  // them, so a duplicate wearing a DIFFERENT MBID carries a different act's links.
  const dupRow = duplicate
    ? ((await db.execute({ args: [duplicate.id], sql: `select * from artists where id = ?` }))
        .rows[0] as ArtistRow | undefined)
    : {};
  const canonRow = (
    await db.execute({ args: [canonical.id], sql: `select * from artists where id = ?` })
  ).rows[0] as ArtistRow | undefined;

  if (!dupRow || !canonRow) {
    console.log(`\nABORTED — could not read the artists row(s) back from the database.`);

    return 1;
  }

  if (!dropSocials && dupSocials.length > 0 && dupRow.mbid !== canonRow.mbid) {
    console.log(
      `\n  ⚠ the duplicate's MBID (${String(dupRow.mbid)}) differs from the canonical's` +
        ` (${String(canonRow.mbid)}), so those ${dupSocials.length} channel(s) were resolved for a` +
        ` DIFFERENT identity. Pass --drop-duplicate-socials to delete them instead of moving them.`,
    );
  }

  const { filled, set } = reconcile(canonRow, dupRow, setMbid);

  console.log(`\nidentity on the surviving row:`);
  console.log(`  mbid: ${String(canonRow.mbid)} → ${String(set.mbid ?? canonRow.mbid)}`);
  console.log(
    `  filled from the duplicate: ${filled.length > 0 ? filled.join(", ") : "(nothing)"}`,
  );

  if ("resolved_at" in set && set.resolved_at === null) {
    console.log(`  resolved_at CLEARED — the resolver re-walks the new identity.`);
  }

  if (setMbid && canonRow.bio && canonRow.mbid !== setMbid) {
    console.log(
      `  ⚠ the canonical carries a stored bio authored under the OLD identity. Review it after` +
        ` the merge — the bio sweep will NOT overwrite a non-empty bio.`,
    );
  }

  if (duplicate) {
    console.log(
      `\nalias written: "${duplicate.name}" (${duplicate.slug}) → confirmed operator alias on` +
        ` ${canonical.slug}, so the merged-away slug can never be re-minted.`,
    );
  }

  // ── the maintained hub counts: census the tracks that ACTUALLY move, then `+=` ────────────────
  // Delta arithmetic is the law on a bulk path (a recompute-from-truth measured 137× worse). The
  // `not exists` clause is the double-edge collapse: a track the canonical ALREADY credits is not a
  // new linked track, so it must not be counted. The join to `tracks` drops orphaned edges, because
  // `renderable_track_count` counts linked TRACKS, not edges.
  //
  // A repoint-only run moves no edge, so it moves no counter — the census is skipped entirely.
  const census = duplicate
    ? ((
        await db.execute({
          args: [duplicate.id, canonical.id],
          sql: `select count(*) as renderable,
                   coalesce(sum(case when t.is_catalogue = 0 then 1 else 0 end), 0) as certified
              from track_artists ta
              join tracks t on t.track_id = ta.track_id
             where ta.artist_id = ?
               and not exists (select 1 from track_artists c
                                where c.track_id = ta.track_id and c.artist_id = ?)`,
        })
      ).rows[0] as { certified?: unknown; renderable?: unknown } | undefined)
    : undefined;
  const credit = {
    certified: Number(census?.certified ?? 0),
    renderable: Number(census?.renderable ?? 0),
  };

  if (duplicate) {
    console.log(
      `\nhub counts on ${canonical.slug}: renderable +${credit.renderable} · certified +${credit.certified}`,
    );
  }

  if (!confirm) {
    console.log(`\nDRY RUN — nothing written. Take a fresh backup, then re-run with --confirm.`);

    return 0;
  }

  // ── rollback, captured BEFORE anything changes ───────────────────────────────────────────────
  // Both `artists` rows, because the merge edits the canonical as well as deleting the duplicate,
  // and every referencing row for BOTH — a restore has to know what the canonical held before the
  // or-ignore collapse, not just what the duplicate lost.
  const rollback = {
    at: now(),
    canonical: canonRow,
    canonicalReferences: Object.fromEntries(canonicalRefRows),
    duplicate: dupRow,
    duplicateReferences: Object.fromEntries(duplicateRefRows),
    hubCountCredit: credit,
    mode: duplicate ? "merge-artist" : "repoint-artist",
    reconciled: filled,
  };
  const path = duplicate
    ? `${out}/merge-artist-${duplicate.slug}-into-${canonical.slug}-rollback.json`
    : `${out}/repoint-artist-${canonical.slug}-rollback.json`;
  writeFileSync(path, JSON.stringify(rollback, null, 2));
  console.log(`\nrollback → ${path}`);

  // ── ONE write transaction, `mergeLabel`'s order ───────────────────────────────────────────────
  const stamp = now();
  const statements: MergeStatement[] = duplicate
    ? [
        // 0: DELETE the duplicate FIRST — frees its UNIQUE `slug` and `spotify_artist_id` before the
        //    canonical adopts them. Every re-point below matches the duplicate's id VALUE (a plain
        //    string column with no SQL cascade — verified against the live DDL), so they still land.
        { args: [duplicate.id], sql: `delete from artists where id = ?` },
        // 1..n: settle every reference — re-point what moves, sweep what is left.
        ...references.flatMap((ref) => referenceStatements(ref, canonical.id, duplicate.id)),
      ]
    : [];

  // The identity + facts onto the canonical. Column names come from a CLOSED literal list, never
  // from caller input — libSQL has no bind slot for an identifier (`mergeLabel`'s note).
  const setColumns = Object.keys(set);
  const assignments = [...setColumns.map((c) => `${c} = ?`), `updated_at = ?`].join(", ");
  statements.push({
    args: [...setColumns.map((c) => set[c] ?? null), stamp, canonical.id],
    sql: `update artists set ${assignments} where id = ?`,
  });

  if (duplicate) {
    // The merged-away NAME + SLUG as a confirmed operator alias, so no later backfill re-mints it.
    statements.push({
      args: [`ala_${newId()}`, canonical.id, duplicate.name, duplicate.slug, stamp],
      sql: `insert into artist_aliases (id, artist_id, alias, alias_slug, source, kind, status, created_at)
          values (?, ?, ?, ?, 'operator', 'name', 'confirmed', ?)
          on conflict (artist_id, alias_slug, source) do nothing`,
    });

    // The canonical adopts the counts the moved tracks imply — SAME batch as the re-point, so the
    // edge move and the counters it implies can never half-apply.
    statements.push({
      args: [credit.renderable, credit.certified, canonical.id],
      sql: `update artists
            set renderable_track_count = max(0, renderable_track_count + ?),
                certified_finding_count = max(0, certified_finding_count + ?)
          where id = ?`,
    });
  }

  const results = await db.batch(statements, "write");

  for (const [i, statement] of statements.entries()) {
    console.log(
      `  [${String(i).padStart(2)}] ${Number(results[i]?.rowsAffected ?? 0)} row(s)  ` +
        `${statement.sql.replaceAll(/\s+/g, " ").trim().slice(0, 96)}`,
    );
  }

  console.log(`\nDONE. Rollback: ${path}`);
  // HUB COUNTS are moved in-batch above, so they need no sweep. The artist-dossier sweep recomputes
  // the dropped centroid/similar rows on its next tick, via the `rank_corpus` fingerprint.

  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
