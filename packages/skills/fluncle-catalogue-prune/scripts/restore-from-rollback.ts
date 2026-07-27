#!/usr/bin/env bun
// THE UNDO — put rows a purge deleted back, from the rollback JSON that purge wrote.
//
//   # what would come back, and what is already there
//   bun run packages/skills/fluncle-catalogue-prune/scripts/restore-from-rollback.ts \
//     --rollback apps/web/.dev/catalogue-prune/edgeless-rollback.json \
//     --tracks mb_eb3dc715-2b8c-44e3-8d50-ab422a0c831a,mb_eb5c1f5d-4d62-475b-aca6-3b8e8a08854d
//
//   # …then re-run with --confirm. Dry-run by default.
//
//   --tracks accepts a comma/space-separated list, `@path/to/file` (one id per line), or `all`.
//
// WHY IT EXISTS. Every destructive tool in this skill writes a verbatim `select *` snapshot of the
// rows it is about to delete. Until now nothing READ those files — the rollback was a promise, not
// a capability, and a promise you have never executed is not a rollback. It also answers the
// narrower question that actually comes up: a purge was RIGHT about a label and WRONG about a
// handful of rows under it, and only those rows should come back.
//
// WHAT IT RESTORES, parents before children:
//   albums → artists → tracks → track_artists
// each `insert or ignore`, so a row that is already there is left exactly as it is. Running it
// twice changes nothing the first run did not.
//
// WHAT IT DELIBERATELY DOES NOT RESTORE:
//   - `cost_events`. A rollback captures them because they reference the track, but they are a
//     ledger of money ALREADY SPENT. Re-inserting them would double-count that spend against a
//     restored track. The rows stay deleted on purpose.
//   - THE MAINTAINED HUB COUNTS. A restore leaves `renderable_track_count` /
//     `certified_finding_count` alone, exactly as every purge in this skill does: the counters lag,
//     and the nightly `reconcile_hub_counts` sweep recomputes them from truth within a day. Moving
//     them here would DOUBLE-count against that sweep.
//
// SCHEMA DRIFT is handled rather than assumed: a rollback is a snapshot of the columns that existed
// when it was written. Each insert is built from the intersection of the snapshot's columns and the
// LIVE table's columns (`pragma table_info`), so a column added since simply takes its default, and
// a column dropped since is reported instead of throwing halfway through.
import { readFileSync } from "node:fs";

import { type Client } from "@libsql/client/web";

import { chunk, getDb } from "./lib";

export type Row = Record<string, null | number | string>;

/** The shape every rollback file in this skill shares. Sections are optional by design: the
 *  edgeless purge deleted tracks that had NO artist edges, so its file carries no `artists` and no
 *  `track_artists` at all. */
export type Rollback = {
  albums?: Row[];
  artists?: Row[];
  track_artists?: Row[];
  tracks?: Row[];
};

export type RestorePlan = {
  albums: Row[];
  artists: Row[];
  edges: Row[];
  /** Requested ids the file does not hold — a HARD ABORT: the wrong rollback file was named. */
  missingTrackIds: string[];
  tracks: Row[];
};

/**
 * Work out the full set of rows the named tracks need to exist again. Pure — no database.
 *
 * The closure runs track → album → artist: a restored track needs its `albums` row (the purge
 * deleted an album only when it lost its LAST track, so usually it survived and nothing is needed
 * here), its `track_artists` edges, and the `artists` rows those edges point at. A track whose
 * edges were never captured — the edgeless case — restores as a track with no artist credit, which
 * is exactly the state it was deleted in.
 */
export function planRestore(rollback: Rollback, trackIds: readonly string[]): RestorePlan {
  const wanted = new Set(trackIds);
  const tracks = (rollback.tracks ?? []).filter((t) => wanted.has(String(t.track_id)));
  const found = new Set(tracks.map((t) => String(t.track_id)));
  const edges = (rollback.track_artists ?? []).filter((e) => found.has(String(e.track_id)));
  const albumIds = new Set(tracks.map((t) => t.album_id).filter((id): id is string => Boolean(id)));
  const artistIds = new Set(edges.map((e) => String(e.artist_id)));

  return {
    albums: (rollback.albums ?? []).filter((a) => albumIds.has(String(a.id))),
    artists: (rollback.artists ?? []).filter((a) => artistIds.has(String(a.id))),
    edges,
    missingTrackIds: [...wanted].filter((id) => !found.has(id)),
    tracks,
  };
}

/** Parse `--tracks`: a comma/space list, `@file` (one id per line), or `all`. */
export function parseTrackArg(value: string, rollback: Rollback): string[] {
  if (value === "all") {
    return (rollback.tracks ?? []).map((t) => String(t.track_id));
  }

  const raw = value.startsWith("@") ? readFileSync(value.slice(1), "utf8") : value;

  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The live column list for a table — the drift guard's other half. */
async function liveColumns(db: Client, table: string): Promise<Set<string>> {
  const result = await db.execute(`pragma table_info(${table})`);

  return new Set(result.rows.map((r) => String((r as { name?: unknown }).name)));
}

/** Which of `ids` the table already holds, so the report can separate NEW from ALREADY THERE. */
async function existingIds(
  db: Client,
  table: string,
  column: string,
  ids: string[],
): Promise<Set<string>> {
  const out = new Set<string>();

  for (const c of chunk(ids)) {
    const result = await db.execute({
      args: c,
      sql: `select ${column} as id from ${table} where ${column} in (${c.map(() => "?").join(",")})`,
    });

    for (const row of result.rows) {
      out.add(String((row as { id?: unknown }).id));
    }
  }

  return out;
}

export type InsertBatch = { args: (null | number | string)[]; sql: string }[];

/**
 * `insert or ignore` statements for one table, built from the columns the snapshot and the LIVE
 * table BOTH have. `or ignore` is the idempotence: a row already present is left untouched rather
 * than overwritten, so a restore can never clobber a row someone has since edited.
 */
export function insertStatements(table: string, rows: Row[], columns: ReadonlySet<string>) {
  return rows.map((row) => {
    const cols = Object.keys(row).filter((c) => columns.has(c));

    return {
      args: cols.map((c) => row[c] ?? null),
      sql: `insert or ignore into ${table} (${cols.join(", ")})
            values (${cols.map(() => "?").join(", ")})`,
    };
  });
}

// ── I/O ──────────────────────────────────────────────────────────────────────────────────────────

const flag = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);

  return i >= 0 ? argv[i + 1] : undefined;
};

export async function main(
  argv: string[] = process.argv.slice(2),
  openDb: () => Promise<Client> = getDb,
  readRollback: (path: string) => Rollback = (path) =>
    JSON.parse(readFileSync(path, "utf8")) as Rollback,
): Promise<number> {
  const confirm = argv.includes("--confirm");
  const rollbackPath = flag(argv, "--rollback");
  const tracksArg = flag(argv, "--tracks");

  if (!rollbackPath || !tracksArg) {
    console.log(
      `Nothing to do. Pass --rollback <file.json> --tracks <id,id|@file|all> [--confirm].`,
    );

    return 0;
  }

  console.log(`\n===== RESTORE FROM ROLLBACK (${confirm ? "WRITE" : "DRY RUN"}) =====`);
  console.log(`rollback: ${rollbackPath}`);

  let rollback: Rollback;

  try {
    rollback = readRollback(rollbackPath);
  } catch (error) {
    console.log(`\nABORTED — could not read the rollback file: ${String(error)}`);

    return 1;
  }

  const trackIds = parseTrackArg(tracksArg, rollback);

  if (trackIds.length === 0) {
    console.log(`\nABORTED — --tracks resolved to no ids.`);

    return 1;
  }

  const plan = planRestore(rollback, trackIds);

  // A named id the file does not hold means the WRONG rollback was passed. A hard abort rather than
  // a partial restore: restoring some of what was asked for, silently, is the worse outcome.
  if (plan.missingTrackIds.length > 0) {
    console.log(
      `\nABORTED — ${plan.missingTrackIds.length} requested track(s) are not in this rollback file:`,
    );

    for (const id of plan.missingTrackIds.slice(0, 20)) {
      console.log(`  ${id}`);
    }

    console.log(`  Check the file — a rollback only holds what ITS run deleted.`);

    return 1;
  }

  const db = await openDb();
  const sections: { column: string; rows: Row[]; table: string }[] = [
    { column: "id", rows: plan.albums, table: "albums" },
    { column: "id", rows: plan.artists, table: "artists" },
    { column: "track_id", rows: plan.tracks, table: "tracks" },
  ];

  console.log(``);

  for (const section of sections) {
    const ids = section.rows.map((r) => String(r[section.column]));
    const present =
      ids.length > 0
        ? await existingIds(db, section.table, section.column, ids)
        : new Set<string>();
    console.log(
      `  ${section.table.padEnd(14)} ${section.rows.length} in the file · ` +
        `${present.size} already live · ${section.rows.length - present.size} to insert`,
    );
  }

  console.log(`  ${"track_artists".padEnd(14)} ${plan.edges.length} edge(s) in the file`);

  for (const track of plan.tracks.slice(0, 30)) {
    console.log(
      `    "${String(track.title)}"  ·  ${String(track.album)}  ·  ${String(track.label)}`,
    );
  }

  if (plan.tracks.length > 30) {
    console.log(`    … and ${plan.tracks.length - 30} more`);
  }

  if (plan.edges.length === 0 && plan.tracks.length > 0) {
    console.log(
      `\n  note: this rollback captured no artist edges for these tracks, so they restore with no` +
        ` artist credit — the state they were deleted in.`,
    );
  }

  if (!confirm) {
    console.log(`\nDRY RUN — nothing written. Re-run with --confirm.`);

    return 0;
  }

  // ── the inserts, parents before children, each table in ONE write transaction ─────────────────
  const written: string[] = [];

  for (const section of [
    ...sections,
    { column: "track_id", rows: plan.edges, table: "track_artists" },
  ]) {
    if (section.rows.length === 0) {
      continue;
    }

    const columns = await liveColumns(db, section.table);
    const snapshot = new Set(section.rows.flatMap((r) => Object.keys(r)));
    const dropped = [...snapshot].filter((c) => !columns.has(c));

    if (dropped.length > 0) {
      console.log(
        `  ⚠ ${section.table}: the snapshot carries ${dropped.length} column(s) the live table no` +
          ` longer has (${dropped.join(", ")}) — they are skipped, the rest of the row restores.`,
      );
    }

    let inserted = 0;

    for (const c of chunk(insertStatements(section.table, section.rows, columns), 50)) {
      const results = await db.batch(c, "write");
      inserted += results.reduce((n, r) => n + Number(r?.rowsAffected ?? 0), 0);
    }

    written.push(`${section.table}: ${inserted}`);
    console.log(`  inserted ${section.table}: ${inserted}`);
  }

  console.log(`\nDONE. ${written.join(" · ")}`);
  // HUB COUNTS lag exactly as they do after a purge — the nightly `reconcile_hub_counts` sweep
  // recomputes them from truth within a day. See the header.

  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
