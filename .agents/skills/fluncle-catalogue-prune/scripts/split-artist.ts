#!/usr/bin/env bun

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
  albumIds: string[];

  impostorTrackIds: string[];

  keptTrackIds: string[];

  sharedTrackIds: string[];
};

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

async function reportSplitDetails(
  cat: Catalogue,
  plan: ReturnType<typeof planSplit>,
  mode: SplitMode,
  intoName: string | undefined,
  intoMbid: string | null,
): Promise<boolean> {
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
    return reportStripPlan(cat.db, new Set(plan.impostorTrackIds), plan.albumIds);
  }

  const taken = new Set(cat.artists.map((artist) => artist.slug));
  console.log(`\nnew artist row: "${intoName}" → slug ${mintSlug(intoName ?? "", taken)}`);
  console.log(`  mbid: ${intoMbid ?? "(none — pass --into-mbid to make it identity-true)"}`);
  return true;
}

async function applySplitPlan(
  cat: Catalogue,
  artist: Catalogue["artists"][number],
  plan: ReturnType<typeof planSplit>,
  mode: SplitMode,
  intoName: string | undefined,
  intoMbid: string | null,
  newId: () => string,
): Promise<void> {
  if (mode === "strip") {
    const removed = await deleteTracksWithEdges(cat.db, plan.impostorTrackIds);
    console.log(`  deleted track_artists.track_id: ${removed.edges}`);
    console.log(`  deleted tracks.track_id: ${removed.tracks}`);

    for (const ids of chunk(plan.albumIds)) {
      const result = await cat.db.execute({
        args: ids,
        sql: `delete from albums where id in (${ids.map(() => "?").join(",")})`,
      });
      console.log(`  deleted albums: ${Number(result.rowsAffected)}`);
    }
    return;
  }

  const taken = new Set(cat.artists.map((candidate) => candidate.slug));
  const moved = await applySplit(
    cat.db,
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

  if (plan.keptTrackIds.length === 0) {
    console.log(
      `\nABORTED — this artist has NO tracks outside the impostor labels, so it is not a conflated` +
        ` row. That is a whole-artist namesake: use purge-artists.ts instead.`,
    );

    return 1;
  }

  const findings = plan.impostorTrackIds.filter((id) => cat.findingTrackIds.has(id));

  if (findings.length > 0) {
    console.log(`\nABORTED — ${findings.length} impostor-side track(s) carry a findings row.`);

    return 1;
  }

  if (!(await reportSplitDetails(cat, plan, mode, intoName, intoMbid))) {
    return 1;
  }

  if (!confirm) {
    console.log(`\nDRY RUN — nothing written. Take a fresh backup, then re-run with --confirm.`);

    return 0;
  }

  const rollback = await captureArtistCascadeRollback(
    db,
    [artist.id],
    plan.impostorTrackIds,
    mode === "strip" ? plan.albumIds : [],
  );
  const path = `${out}/split-artist-${artist.slug}-rollback.json`;
  writeFileSync(path, JSON.stringify({ ...rollback, mode }, null, 2));
  console.log(`\nrollback → ${path}`);

  await applySplitPlan(cat, artist, plan, mode, intoName, intoMbid, newId);

  console.log(`\nDONE. Rollback: ${path}`);

  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
