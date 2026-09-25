#!/usr/bin/env bun

import { writeFileSync } from "node:fs";

import { type Client, type Row } from "@libsql/client/web";

import { type Catalogue, loadCatalogue, rowString } from "./lib";

export type ArtistReference = {
  column: string;

  filter?: string;

  mode: "drop" | "repoint";

  table: string;
};

export const ARTIST_REFERENCES: ArtistReference[] = [
  { column: "artist_id", mode: "repoint", table: "track_artists" },

  { column: "artist_id", mode: "repoint", table: "artist_socials" },

  { column: "artist_id", mode: "repoint", table: "artist_aliases" },
  { column: "artist_id", mode: "drop", table: "artist_centroids" },
  { column: "artist_id", mode: "drop", table: "artist_similar" },
  { column: "neighbour_artist_id", mode: "drop", table: "artist_similar" },

  { column: "entity_id", filter: `kind = 'artist'`, mode: "repoint", table: "user_watches" },
];

const refWhere = (ref: ArtistReference): string =>
  `${ref.column} = ?${ref.filter ? ` and ${ref.filter}` : ""}`;

export type MergeStatement = { args: (null | number | string)[]; sql: string };

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

export type MergePlan = {
  collapsedTrackIds: string[];

  findingBlockerTrackIds: string[];

  findingInheritedTrackIds: string[];

  movedTrackIds: string[];
};

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

    findingBlockerTrackIds: movedTrackIds.filter((id) => cat.findingTrackIds.has(id)),

    findingInheritedTrackIds: collapsedTrackIds.filter((id) => cat.findingTrackIds.has(id)),
    movedTrackIds,
  };
}

export type ArtistRow = Record<string, null | number | string>;

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

export const RECONCILED_GROUPS: { key: string; members: string[] }[] = [
  { key: "image_key", members: ["image_key", "image_source", "image_state", "image_updated_at"] },
  { key: "bio", members: ["bio", "bio_prompt_version", "bio_status"] },
];

export type Reconciliation = {
  filled: string[];

  set: ArtistRow;
};

export function reconcile(
  canonical: ArtistRow,
  duplicate: ArtistRow,
  setMbid?: string,
): Reconciliation {
  const set: ArtistRow = {};
  const filled: string[] = [];
  const empty = (v: ArtistRow[string] | undefined) => v === null || v === undefined || v === "";

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
      set.resolved_at = null;

      return { filled: filled.filter((f) => f !== "resolved_at"), set };
    }
  }

  return { filled, set };
}

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

async function selectRefRows(db: Client, ref: ArtistReference, artistId: string): Promise<Row[]> {
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

function reportReconciledIdentity(
  canonRow: ArtistRow,
  dupRow: ArtistRow,
  dupSocials: Row[],
  dropSocials: boolean,
  setMbid: string | undefined,
): ReturnType<typeof reconcile> {
  if (!dropSocials && dupSocials.length > 0 && dupRow.mbid !== canonRow.mbid) {
    console.log(
      `\n  ⚠ the duplicate's MBID (${String(dupRow.mbid)}) differs from the canonical's` +
        ` (${String(canonRow.mbid)}), so those ${dupSocials.length} channel(s) were resolved for a` +
        ` DIFFERENT identity. Pass --drop-duplicate-socials to delete them instead of moving them.`,
    );
  }

  const reconciled = reconcile(canonRow, dupRow, setMbid);
  console.log(`\nidentity on the surviving row:`);
  console.log(`  mbid: ${String(canonRow.mbid)} → ${String(reconciled.set.mbid ?? canonRow.mbid)}`);
  console.log(
    `  filled from the duplicate: ${reconciled.filled.length > 0 ? reconciled.filled.join(", ") : "(nothing)"}`,
  );

  if ("resolved_at" in reconciled.set && reconciled.set.resolved_at === null) {
    console.log(`  resolved_at CLEARED — the resolver re-walks the new identity.`);
  }

  if (setMbid && canonRow.bio && canonRow.mbid !== setMbid) {
    console.log(
      `  ⚠ the canonical carries a stored bio authored under the OLD identity. Review it after` +
        ` the merge — the bio sweep will NOT overwrite a non-empty bio.`,
    );
  }

  return reconciled;
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

  if (reportFindingBlocker(cat, plan)) {
    return 1;
  }

  const references = referencesForMerge(dropSocials);
  const duplicateRefRows = new Map<string, Row[]>();
  const canonicalRefRows = new Map<string, Row[]>();

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

  for (const row of dupSocials) {
    console.log(
      `    ${dropSocials ? "DROP" : "MOVE"} social ${rowString(row, "platform")} ${rowString(row, "url")}`,
    );
  }

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

  const { filled, set } = reportReconciledIdentity(
    canonRow,
    dupRow,
    dupSocials,
    dropSocials,
    setMbid,
  );

  if (duplicate) {
    console.log(
      `\nalias written: "${duplicate.name}" (${duplicate.slug}) → confirmed operator alias on` +
        ` ${canonical.slug}, so the merged-away slug can never be re-minted.`,
    );
  }

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

  const stamp = now();
  const statements: MergeStatement[] = duplicate
    ? [
        { args: [duplicate.id], sql: `delete from artists where id = ?` },

        ...references.flatMap((ref) => referenceStatements(ref, canonical.id, duplicate.id)),
      ]
    : [];

  const setColumns = Object.keys(set);
  const assignments = [...setColumns.map((c) => `${c} = ?`), `updated_at = ?`].join(", ");
  statements.push({
    args: [...setColumns.map((c) => set[c] ?? null), stamp, canonical.id],
    sql: `update artists set ${assignments} where id = ?`,
  });

  if (duplicate) {
    statements.push({
      args: [`ala_${newId()}`, canonical.id, duplicate.name, duplicate.slug, stamp],
      sql: `insert into artist_aliases (id, artist_id, alias, alias_slug, source, kind, status, created_at)
          values (?, ?, ?, ?, 'operator', 'name', 'confirmed', ?)
          on conflict (artist_id, alias_slug, source) do nothing`,
    });

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

  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
