#!/usr/bin/env bun
/**
 * Derive the read-only public catalogue database shipped to mobile devices.
 *
 * The source is opened with SQLite's read-only flag and is never mutated. The output schema is
 * generated exclusively from the allowlist in lib/device-db-schema.ts; source-only cut inputs
 * such as the MuQ vector, storage pointers, admin state, auth, and telemetry never cross the
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

import { REC_ELIGIBLE_WHERE } from "../src/lib/catalogue-eligibility";
import {
  createDeviceTableSql as createTableSql,
  type DeviceDbCut as Cut,
  type DeviceDbSqliteColumn as SqliteColumn,
  DEVICE_DB_INDEXES,
  insertDeviceTableSql,
  quoteDeviceDbIdentifier as quoteIdentifier,
} from "./lib/device-db-derivation";
import {
  DEVICE_DB_COLUMNS,
  DEVICE_DB_SCHEMA_VERSION,
  DEVICE_SOURCE_TABLES,
  DEVICE_SYNC_META_COLUMNS,
  type DeviceSourceTable,
} from "./lib/device-db-schema";

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

function createIndexes(source: Database): void {
  for (const index of DEVICE_DB_INDEXES) {
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
        output.run(insertDeviceTableSql(table, args.cut, REC_ELIGIBLE_WHERE));
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
