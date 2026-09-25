#!/usr/bin/env bun

import { readFileSync } from "node:fs";

import { type Client } from "@libsql/client/web";

import { chunk, getDb } from "./lib";
import { insertTrackDuplicateKeyStatement } from "../../../../apps/web/src/lib/server/track-duplicate-keys";

export type Row = Record<string, null | number | string>;

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

  missingTrackIds: string[];
  tracks: Row[];
};

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

async function liveColumns(db: Client, table: string): Promise<Set<string>> {
  const result = await db.execute(`pragma table_info(${table})`);

  return new Set(result.rows.map((r) => String((r as { name?: unknown }).name)));
}

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

    for (const rows of chunk(section.rows, 50)) {
      const primaryStatements = insertStatements(section.table, rows, columns);
      const duplicateKeyStatements =
        section.table === "tracks"
          ? rows.map((row) => {
              const trackId = row.track_id;
              const title = row.title;
              const artistsJson = row.artists_json;

              if (
                typeof trackId !== "string" ||
                typeof title !== "string" ||
                typeof artistsJson !== "string"
              ) {
                throw new Error(
                  "Rollback track rows need string track_id, title, and artists_json fields",
                );
              }

              return insertTrackDuplicateKeyStatement({
                artistsJson,
                isrc: typeof row.isrc === "string" ? row.isrc : null,
                title,
                trackId,
              });
            })
          : [];
      const results = await db.batch([...primaryStatements, ...duplicateKeyStatements], "write");
      inserted += results
        .slice(0, primaryStatements.length)
        .reduce((n, r) => n + Number(r?.rowsAffected ?? 0), 0);
    }

    written.push(`${section.table}: ${inserted}`);
    console.log(`  inserted ${section.table}: ${inserted}`);
  }

  console.log(`\nDONE. ${written.join(" · ")}`);

  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
