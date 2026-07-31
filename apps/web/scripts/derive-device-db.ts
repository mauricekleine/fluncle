#!/usr/bin/env bun
/**
 * Derive the read-only public catalogue database shipped to mobile devices.
 *
 * The source is opened with SQLite's read-only flag and is never mutated. The output schema is
 * generated exclusively from the allowlist in lib/device-db-schema.ts; source-only cut inputs
 * such as `embedding_blob`, storage pointers, admin state, auth, and telemetry never cross the
 * boundary.
 *
 * Usage:
 *   bun apps/web/scripts/derive-device-db.ts \
 *     --source "apps/web/.dev/local.db" \
 *     --out "/tmp/fluncle-device-full.db" \
 *     --cut "full"
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { REC_ELIGIBLE_WHERE } from "../src/lib/server/recommendations";
import {
  DEVICE_DB_COLUMNS,
  DEVICE_DB_SCHEMA_VERSION,
  DEVICE_SOURCE_TABLES,
  DEVICE_SYNC_META_COLUMNS,
  type DeviceSourceTable,
} from "./lib/device-db-schema";

type Cut = "anchored" | "certified" | "full";

type SqliteColumn = {
  cid: number;
  dflt_value: null | string;
  name: string;
  notnull: 0 | 1;
  pk: number;
  type: string;
};

type DerivationArgs = {
  cut: Cut;
  out: string;
  source: string;
};

type SourceInspection = {
  derivedAt: string;
  rowCounts: Record<string, number>;
  schema: Map<DeviceSourceTable, SqliteColumn[]>;
};

type DeviceIndex = {
  columns: readonly string[];
  name: string;
  table: DeviceSourceTable;
  unique?: boolean;
};

const DEVICE_INDEXES: readonly DeviceIndex[] = [
  { columns: ["album_id"], name: "device_tracks_album_id_idx", table: "tracks" },
  { columns: ["label_id"], name: "device_tracks_label_id_idx", table: "tracks" },
  { columns: ["is_catalogue"], name: "device_tracks_is_catalogue_idx", table: "tracks" },
  { columns: ["release_date"], name: "device_tracks_release_date_idx", table: "tracks" },
  {
    columns: ["log_id"],
    name: "device_findings_log_id_idx",
    table: "findings",
    unique: true,
  },
  { columns: ["added_at"], name: "device_findings_added_at_idx", table: "findings" },
  { columns: ["slug"], name: "device_artists_slug_idx", table: "artists", unique: true },
  { columns: ["slug"], name: "device_labels_slug_idx", table: "labels", unique: true },
  { columns: ["parent_label_id"], name: "device_labels_parent_id_idx", table: "labels" },
  { columns: ["slug"], name: "device_albums_slug_idx", table: "albums", unique: true },
  {
    columns: ["track_id"],
    name: "device_track_artists_track_id_idx",
    table: "track_artists",
  },
  {
    columns: ["artist_id"],
    name: "device_track_artists_artist_id_idx",
    table: "track_artists",
  },
];

const INSERT_ORDER: Record<DeviceSourceTable, readonly string[]> = {
  albums: ["id"],
  artists: ["id"],
  findings: ["track_id"],
  labels: ["id"],
  track_artists: ["track_id", "artist_id"],
  tracks: ["track_id"],
};

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function parseArgs(argv: readonly string[]): DerivationArgs {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];

    if (flag !== "--source" && flag !== "--out" && flag !== "--cut") {
      throw new Error(`Unknown argument: ${flag ?? "(missing)"}`);
    }

    const value = argv[index + 1];

    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }

    if (values.has(flag)) {
      throw new Error(`Duplicate argument: ${flag}`);
    }

    values.set(flag, value);
    index += 1;
  }

  const source = values.get("--source");
  const out = values.get("--out");
  const cut = values.get("--cut");

  if (!source || !out || !cut) {
    throw new Error("Usage: derive-device-db.ts --source <path> --out <path> --cut <name>");
  }

  if (cut !== "full" && cut !== "certified" && cut !== "anchored") {
    throw new Error(`Unknown cut "${cut}". Expected full, certified, or anchored.`);
  }

  return { cut, out: resolve(out), source: resolve(source) };
}

async function sourceWatermark(sourcePath: string): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(sourcePath)) {
    hash.update(chunk);
  }

  return `sha256:${hash.digest("hex")}`;
}

function declaredType(type: string, table: string, column: string): string {
  const normalized = type.trim().toUpperCase();

  if (normalized.includes("INT")) {
    return "INTEGER";
  }
  if (normalized.includes("CHAR") || normalized.includes("CLOB") || normalized.includes("TEXT")) {
    return "TEXT";
  }
  if (normalized.includes("REAL") || normalized.includes("FLOA") || normalized.includes("DOUB")) {
    return "REAL";
  }
  if (normalized === "" || normalized.includes("BLOB")) {
    return "BLOB";
  }
  if (normalized.includes("NUM") || normalized.includes("DEC") || normalized.includes("BOOL")) {
    return "NUMERIC";
  }

  throw new Error(`Unsupported declared type for ${table}.${column}: ${type}`);
}

function tableInfo(source: Database, table: DeviceSourceTable): SqliteColumn[] {
  const rows = source
    .query(`PRAGMA main.table_info(${quoteIdentifier(table)})`)
    .all() as SqliteColumn[];

  if (rows.length === 0) {
    throw new Error(`Source table is missing: ${table}`);
  }

  const available = new Set(rows.map((row) => row.name));

  for (const column of DEVICE_DB_COLUMNS[table]) {
    if (!available.has(column)) {
      throw new Error(`Source column is missing: ${table}.${column}`);
    }
  }

  return rows;
}

function createTableSql(table: DeviceSourceTable, sourceColumns: readonly SqliteColumn[]): string {
  const byName = new Map(sourceColumns.map((column) => [column.name, column]));
  const definitions: string[] = [];

  for (const name of DEVICE_DB_COLUMNS[table]) {
    const column = byName.get(name);

    if (!column) {
      throw new Error(`Source column is missing: ${table}.${name}`);
    }

    definitions.push(
      `${quoteIdentifier(name)} ${declaredType(column.type, table, name)}${
        column.notnull === 1 ? " NOT NULL" : ""
      }`,
    );
  }

  const primaryKey = sourceColumns
    .filter(
      (column) => column.pk > 0 && DEVICE_DB_COLUMNS[table].some((name) => name === column.name),
    )
    .sort((left, right) => left.pk - right.pk)
    .map((column) => quoteIdentifier(column.name));

  if (primaryKey.length > 0) {
    definitions.push(`PRIMARY KEY (${primaryKey.join(", ")})`);
  }

  return `CREATE TABLE main.${quoteIdentifier(table)} (${definitions.join(", ")})`;
}

function selectedTracksCte(cut: Cut): string {
  const where =
    cut === "certified"
      ? "f.track_id is not null"
      : cut === "anchored"
        ? `f.track_id is not null or (${REC_ELIGIBLE_WHERE})`
        : `f.track_id is not null
           or (t.dismissed_at is null and t.duplicate_of_track_id is null)`;

  return `WITH selected_tracks(track_id) AS (
    SELECT t.track_id
    FROM source.${quoteIdentifier("tracks")} AS t
    LEFT JOIN source.${quoteIdentifier("findings")} AS f ON f.track_id = t.track_id
    WHERE ${where}
  )`;
}

function selectedSourceSql(table: DeviceSourceTable, cut: Cut): string {
  const cte = selectedTracksCte(cut);
  const sourceTable = `source.${quoteIdentifier(table)}`;

  if (table === "tracks") {
    return `${cte}
      SELECT source_row.*
      FROM ${sourceTable} AS source_row
      JOIN selected_tracks selected ON selected.track_id = source_row.track_id`;
  }

  if (table === "findings" || table === "track_artists") {
    return `${cte}
      SELECT source_row.*
      FROM ${sourceTable} AS source_row
      JOIN selected_tracks selected ON selected.track_id = source_row.track_id`;
  }

  if (cut === "full") {
    return `SELECT source_row.* FROM ${sourceTable} AS source_row`;
  }

  if (table === "artists") {
    return `${cte}
      SELECT source_row.*
      FROM ${sourceTable} AS source_row
      WHERE source_row.id IN (
        SELECT track_artist.artist_id
        FROM source.${quoteIdentifier("track_artists")} AS track_artist
        JOIN selected_tracks selected ON selected.track_id = track_artist.track_id
      )`;
  }

  const pointer = table === "labels" ? "label_id" : "album_id";

  return `${cte}
    SELECT source_row.*
    FROM ${sourceTable} AS source_row
    WHERE source_row.id IN (
      SELECT track.${quoteIdentifier(pointer)}
      FROM source.${quoteIdentifier("tracks")} AS track
      JOIN selected_tracks selected ON selected.track_id = track.track_id
      WHERE track.${quoteIdentifier(pointer)} IS NOT NULL
    )`;
}

function insertTableSql(table: DeviceSourceTable, cut: Cut): string {
  const columns = DEVICE_DB_COLUMNS[table];
  const projection = columns.map((column) => `source_row.${quoteIdentifier(column)}`).join(", ");
  const order = INSERT_ORDER[table]
    .map((column) => `source_row.${quoteIdentifier(column)}`)
    .join(", ");
  const selectedSql = selectedSourceSql(table, cut).replace(
    "SELECT source_row.*",
    `SELECT ${projection}`,
  );

  return `INSERT INTO main.${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")})
    ${selectedSql}
    ORDER BY ${order}`;
}

function createIndexes(source: Database): void {
  for (const index of DEVICE_INDEXES) {
    source.run(
      `CREATE ${index.unique ? "UNIQUE " : ""}INDEX main.${quoteIdentifier(index.name)}
       ON ${quoteIdentifier(index.table)} (${index.columns.map(quoteIdentifier).join(", ")})`,
    );
  }
}

function countRows(source: Database, schema: "main" | "source", table: string): number {
  const row = source
    .query(`SELECT count(*) AS count FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`)
    .get() as { count: bigint | number } | null;

  if (!row) {
    throw new Error(`Could not count ${schema}.${table}`);
  }

  return Number(row.count);
}

function deterministicDerivedAt(source: Database): string {
  const row = source
    .query(
      `SELECT max(timestamp) AS timestamp
       FROM (
         SELECT max(updated_at) AS timestamp FROM main.findings
         UNION ALL SELECT max(added_at) FROM main.findings
         UNION ALL SELECT max(updated_at) FROM main.artists
         UNION ALL SELECT max(created_at) FROM main.artists
         UNION ALL SELECT max(updated_at) FROM main.labels
         UNION ALL SELECT max(created_at) FROM main.labels
         UNION ALL SELECT max(updated_at) FROM main.albums
         UNION ALL SELECT max(created_at) FROM main.albums
       )`,
    )
    .get() as { timestamp: null | string } | null;

  // A wall-clock timestamp would make identical source + cut inputs produce different content.
  // Use the source's latest public-data timestamp as the reproducible derivation epoch instead.
  return row?.timestamp ?? "1970-01-01T00:00:00.000Z";
}

function inspectSource(sourcePath: string): SourceInspection {
  const source = new Database(sourcePath, { readonly: true, strict: true });

  try {
    return {
      derivedAt: deterministicDerivedAt(source),
      rowCounts: Object.fromEntries(
        DEVICE_SOURCE_TABLES.map((table) => [table, countRows(source, "main", table)]),
      ),
      schema: new Map(DEVICE_SOURCE_TABLES.map((table) => [table, tableInfo(source, table)])),
    };
  } finally {
    source.close();
  }
}

async function removeDatabaseFiles(path: string): Promise<void> {
  await Promise.all([
    rm(path, { force: true }),
    rm(`${path}-shm`, { force: true }),
    rm(`${path}-wal`, { force: true }),
  ]);
}

async function derive(args: DerivationArgs): Promise<void> {
  const startedAt = performance.now();
  const sourceFile = await stat(args.source);

  if (!sourceFile.isFile()) {
    throw new Error(`Source is not a file: ${args.source}`);
  }
  if (args.source === args.out) {
    throw new Error("--source and --out must be different files");
  }

  const sourceWalPath = `${args.source}-wal`;
  const sourceWal = await stat(sourceWalPath).catch(() => undefined);

  if (sourceWal && sourceWal.size > 0) {
    throw new Error(
      `Source has a non-empty WAL (${sourceWalPath}); checkpoint a stable snapshot before deriving.`,
    );
  }

  const watermark = await sourceWatermark(args.source);
  const tempOut = `${args.out}.tmp`;

  await mkdir(dirname(args.out), { recursive: true });
  await removeDatabaseFiles(tempOut);

  const {
    derivedAt,
    rowCounts: sourceRowCounts,
    schema: sourceSchema,
  } = inspectSource(args.source);

  const output = new Database(tempOut, { create: true, strict: true });
  let attached = false;
  let completed = false;

  try {
    const readonlySourceUrl = pathToFileURL(args.source);
    readonlySourceUrl.searchParams.set("mode", "ro");
    output.query("ATTACH DATABASE ? AS source").run(readonlySourceUrl.href);
    attached = true;

    for (const table of DEVICE_SOURCE_TABLES) {
      const sourceColumns = sourceSchema.get(table);

      if (!sourceColumns) {
        throw new Error(`Source schema metadata is missing: ${table}`);
      }

      output.run(createTableSql(table, sourceColumns));
    }

    output.run(
      `CREATE TABLE main.${quoteIdentifier("device_sync_meta")} (
        ${quoteIdentifier(DEVICE_SYNC_META_COLUMNS[0])} INTEGER NOT NULL,
        ${quoteIdentifier(DEVICE_SYNC_META_COLUMNS[1])} TEXT NOT NULL,
        ${quoteIdentifier(DEVICE_SYNC_META_COLUMNS[2])} TEXT NOT NULL,
        ${quoteIdentifier(DEVICE_SYNC_META_COLUMNS[3])} TEXT NOT NULL
      )`,
    );

    const copy = output.transaction(() => {
      for (const table of DEVICE_SOURCE_TABLES) {
        output.run(insertTableSql(table, args.cut));
      }

      createIndexes(output);
      output
        .query(
          `INSERT INTO main.${quoteIdentifier("device_sync_meta")} (
            ${DEVICE_SYNC_META_COLUMNS.map(quoteIdentifier).join(", ")}
          ) VALUES (?, ?, ?, ?)`,
        )
        .run(DEVICE_DB_SCHEMA_VERSION, args.cut, derivedAt, watermark);
    });

    copy.immediate();

    const rowCounts = Object.fromEntries([
      ...DEVICE_SOURCE_TABLES.map((table) => [table, countRows(output, "main", table)]),
      ["device_sync_meta", countRows(output, "main", "device_sync_meta")],
    ]);
    const preVacuumBytes = (await stat(tempOut)).size;

    output.run("DETACH DATABASE source");
    attached = false;
    output.run("VACUUM");
    output.close();

    const postVacuumBytes = (await stat(tempOut)).size;
    const watermarkAfterDerivation = await sourceWatermark(args.source);
    const sourceWalAfterDerivation = await stat(sourceWalPath).catch(() => undefined);

    if (watermarkAfterDerivation !== watermark) {
      throw new Error("Source changed during derivation; discarded the inconsistent output.");
    }
    if (sourceWalAfterDerivation && sourceWalAfterDerivation.size > 0) {
      throw new Error("Source WAL changed during derivation; discarded the inconsistent output.");
    }

    await removeDatabaseFiles(args.out);
    await rename(tempOut, args.out);
    completed = true;

    console.log(
      JSON.stringify(
        {
          cut: args.cut,
          derivedAt,
          elapsedMs: Math.round(performance.now() - startedAt),
          out: args.out,
          postVacuumBytes,
          preVacuumBytes,
          rowCounts,
          schemaVersion: DEVICE_DB_SCHEMA_VERSION,
          source: args.source,
          sourceRowCounts,
          sourceWatermark: watermark,
        },
        null,
        2,
      ),
    );
  } finally {
    if (attached) {
      try {
        output.run("DETACH DATABASE source");
      } catch {
        // The original derivation error is more useful than a best-effort detach failure.
      }
    }

    try {
      output.close();
    } catch {
      // The handle may already be closed after a successful detach.
    }

    if (!completed) {
      await removeDatabaseFiles(tempOut);
    }
  }
}

await derive(parseArgs(Bun.argv.slice(2)));
