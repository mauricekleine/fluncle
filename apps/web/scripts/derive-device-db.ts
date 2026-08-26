#!/usr/bin/env bun
/**
 * Derive the read-only public catalogue database shipped to mobile devices.
 *
 * The source is a stable local SQLite/libSQL snapshot. Production first synchronizes its
 * restart-safe embedded replica, closes that client, and invokes this same local-only derivation.
 * The output schema is generated exclusively from DEVICE_DB_COLUMNS; source-only cut inputs such
 * as the MuQ vector, storage pointers, admin state, auth, and telemetry cannot cross the boundary.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { REC_ELIGIBLE_WHERE } from "../src/lib/catalogue-eligibility";
import {
  createDeviceTableSql,
  type DeviceDbCut,
  type DeviceDbSqliteColumn,
  DEVICE_DB_INDEXES,
  deviceDbClosureChecksSql,
  insertDeviceTableSql,
  materializeSelectedTrackIdsSql,
  quoteDeviceDbIdentifier,
  selectDeviceRowsSql,
} from "./lib/device-db-derivation";
import {
  DEVICE_DB_COLUMNS,
  DEVICE_DB_SCHEMA_VERSION,
  DEVICE_SOURCE_TABLES,
  DEVICE_SYNC_META_COLUMNS,
  type DeviceSourceTable,
} from "./lib/device-db-schema";

export type DerivationArgs = {
  cut: DeviceDbCut;
  out: string;
  source: string;
};

export type DeviceArtifactValidation = {
  bytes: number;
  contentFingerprint: string;
  rowCounts: Record<string, number>;
  validation: "verified";
};

export type DeviceDerivationResult = DeviceArtifactValidation & {
  cut: DeviceDbCut;
  derivedAt: string;
  elapsedMs: number;
  out: string;
  preVacuumBytes: number;
  schemaVersion: number;
  selectedTrackCount: number;
  source: string;
  sourceRowCounts: Record<string, number>;
  sourceWatermark: string;
};

export type DeviceDerivationRuntime = {
  afterCopy?: () => void;
  publish?: (temporaryPath: string, destinationPath: string) => Promise<void>;
};

type SourceInspection = {
  derivedAt: string;
  rowCounts: Record<string, number>;
  schema: Map<DeviceSourceTable, DeviceDbSqliteColumn[]>;
};

export function parseDeviceDerivationArgs(argv: readonly string[]): DerivationArgs {
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

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }

  return `sha256:${hash.digest("hex")}`;
}

function tableInfo(source: Database, table: DeviceSourceTable): DeviceDbSqliteColumn[] {
  const rows = source
    .query(`PRAGMA main.table_info(${quoteDeviceDbIdentifier(table)})`)
    .all() as DeviceDbSqliteColumn[];

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

function createIndexes(database: Database): void {
  for (const index of DEVICE_DB_INDEXES) {
    database.run(
      `CREATE ${index.unique ? "UNIQUE " : ""}INDEX main.${quoteDeviceDbIdentifier(index.name)}
       ON ${quoteDeviceDbIdentifier(index.table)} (${index.columns
         .map(quoteDeviceDbIdentifier)
         .join(", ")})`,
    );
  }
}

function countRows(database: Database, schema: "main" | "source" | "temp", table: string): number {
  const row = database
    .query(
      `SELECT count(*) AS count FROM ${quoteDeviceDbIdentifier(schema)}.${quoteDeviceDbIdentifier(table)}`,
    )
    .get() as { count: bigint | number } | null;

  if (!row) {
    throw new Error(`Could not count ${schema}.${table}`);
  }

  return Number(row.count);
}

function countQuery(database: Database, sql: string): number {
  const row = database.query(`SELECT count(*) AS count FROM (${sql})`).get() as {
    count: bigint | number;
  } | null;

  if (!row) {
    throw new Error("Could not count selected device rows");
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

  return row?.timestamp ?? "1970-01-01T00:00:00.000Z";
}

function inspectSource(sourcePath: string): SourceInspection {
  const source = new Database(sourcePath, { readonly: true, strict: true });

  try {
    const integrity = source.query("PRAGMA quick_check").get() as { quick_check: string } | null;

    if (integrity?.quick_check !== "ok") {
      throw new Error(`Source quick_check failed: ${integrity?.quick_check ?? "no result"}`);
    }

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

async function assertStableSource(sourcePath: string): Promise<void> {
  const sourceWalPath = `${sourcePath}-wal`;
  const sourceWal = await stat(sourceWalPath).catch(() => undefined);

  if (sourceWal && sourceWal.size > 0) {
    throw new Error(
      `Source has a non-empty WAL (${sourceWalPath}); checkpoint a stable local snapshot before deriving.`,
    );
  }
}

async function fsyncPath(path: string): Promise<void> {
  const handle = await open(path, "r");

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The destination is never unlinked first: rename is the single publication boundary. */
export async function publishDeviceArtifactAtomically(
  temporaryPath: string,
  destinationPath: string,
): Promise<void> {
  await fsyncPath(temporaryPath);
  await fsyncPath(dirname(destinationPath));
  await rename(temporaryPath, destinationPath);
  await fsyncPath(dirname(destinationPath));
}

function assertClosure(database: Database): void {
  for (const check of deviceDbClosureChecksSql()) {
    const row = database.query(check.sql).get() as { count: bigint | number } | null;
    const violations = Number(row?.count ?? -1);

    if (violations !== 0) {
      throw new Error(`Device reachability violation (${check.edge}): ${violations}`);
    }
  }
}

function assertIndexes(database: Database): void {
  const rows = database.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
    name: string;
  }[];
  const names = new Set(rows.map((row) => row.name));

  for (const index of DEVICE_DB_INDEXES) {
    if (!names.has(index.name)) {
      throw new Error(`Device index is missing: ${index.name}`);
    }
  }
}

export async function validateDeviceArtifact(
  path: string,
  expected: {
    cut: DeviceDbCut;
    rowCounts?: Readonly<Record<string, number>>;
    sourceWatermark: string;
  },
): Promise<DeviceArtifactValidation> {
  const file = await stat(path);

  if (!file.isFile() || file.size <= 0) {
    throw new Error(`Device artifact is missing or empty: ${path}`);
  }

  const database = new Database(path, { readonly: true, strict: true });
  let rowCounts: Record<string, number>;

  try {
    const integrity = database.query("PRAGMA integrity_check").get() as {
      integrity_check: string;
    } | null;

    if (integrity?.integrity_check !== "ok") {
      throw new Error(
        `Device integrity_check failed: ${integrity?.integrity_check ?? "no result"}`,
      );
    }

    for (const table of DEVICE_SOURCE_TABLES) {
      const columns = tableInfo(database, table).map((column) => column.name);

      if (
        columns.length !== DEVICE_DB_COLUMNS[table].length ||
        columns.some((column, index) => column !== DEVICE_DB_COLUMNS[table][index])
      ) {
        throw new Error(`Unexpected device columns for ${table}`);
      }
    }

    const meta = database
      .query(
        `SELECT schema_version, cut_name, derived_at, source_watermark
         FROM device_sync_meta ORDER BY rowid`,
      )
      .all() as {
      cut_name: string;
      derived_at: string;
      schema_version: number;
      source_watermark: string;
    }[];

    if (meta.length !== 1) {
      throw new Error("Device metadata must contain exactly one row");
    }

    const metadata = meta[0];

    if (!metadata) {
      throw new Error("Device metadata row is missing");
    }
    if (metadata.schema_version !== DEVICE_DB_SCHEMA_VERSION) {
      throw new Error(`Unexpected device schema version: ${metadata.schema_version}`);
    }
    if (metadata.cut_name !== expected.cut) {
      throw new Error(`Unexpected device cut: ${metadata.cut_name}`);
    }
    if (metadata.source_watermark !== expected.sourceWatermark) {
      throw new Error("Device source watermark does not match the requested generation");
    }
    if (!metadata.derived_at) {
      throw new Error("Device derived_at is empty");
    }

    rowCounts = Object.fromEntries([
      ...DEVICE_SOURCE_TABLES.map((table) => [table, countRows(database, "main", table)]),
      ["device_sync_meta", countRows(database, "main", "device_sync_meta")],
    ]);

    if (expected.rowCounts) {
      for (const [table, expectedCount] of Object.entries(expected.rowCounts)) {
        if (rowCounts[table] !== expectedCount) {
          throw new Error(
            `Device row count mismatch for ${table}: ${rowCounts[table] ?? "missing"} != ${expectedCount}`,
          );
        }
      }
    }

    assertIndexes(database);
    assertClosure(database);
  } finally {
    database.close();
  }

  return {
    bytes: file.size,
    contentFingerprint: await sha256File(path),
    rowCounts,
    validation: "verified",
  };
}

export async function deriveDeviceDatabase(
  args: DerivationArgs,
  runtime: DeviceDerivationRuntime = {},
): Promise<DeviceDerivationResult> {
  const startedAt = performance.now();
  const sourceFile = await stat(args.source);

  if (!sourceFile.isFile()) {
    throw new Error(`Source is not a file: ${args.source}`);
  }
  if (args.source === args.out) {
    throw new Error("--source and --out must be different files");
  }

  await assertStableSource(args.source);
  const sourceWatermark = await sha256File(args.source);
  const temporaryOut = `${args.out}.tmp`;

  await mkdir(dirname(args.out), { recursive: true });
  await removeDatabaseFiles(temporaryOut);

  const {
    derivedAt,
    rowCounts: sourceRowCounts,
    schema: sourceSchema,
  } = inspectSource(args.source);
  const output = new Database(temporaryOut, { create: true, strict: true });
  let attached = false;
  let published = false;
  let preVacuumBytes = 0;
  let selectedTrackCount = 0;

  try {
    // Bun's SQLite binding does not pass URI `mode=ro` through ATTACH. The source is a private
    // local replica under this process's single-flight lock; every statement names it only in a
    // SELECT, and the before/after byte fingerprint rejects any accidental mutation.
    output.query("ATTACH DATABASE ? AS source").run(args.source);
    attached = true;

    for (const table of DEVICE_SOURCE_TABLES) {
      const sourceColumns = sourceSchema.get(table);

      if (!sourceColumns) {
        throw new Error(`Source schema metadata is missing: ${table}`);
      }

      output.run(createDeviceTableSql(table, sourceColumns));
    }

    output.run(
      `CREATE TABLE main.${quoteDeviceDbIdentifier("device_sync_meta")} (
        ${quoteDeviceDbIdentifier(DEVICE_SYNC_META_COLUMNS[0])} INTEGER NOT NULL,
        ${quoteDeviceDbIdentifier(DEVICE_SYNC_META_COLUMNS[1])} TEXT NOT NULL,
        ${quoteDeviceDbIdentifier(DEVICE_SYNC_META_COLUMNS[2])} TEXT NOT NULL,
        ${quoteDeviceDbIdentifier(DEVICE_SYNC_META_COLUMNS[3])} TEXT NOT NULL
      )`,
    );

    const expectedRowCounts: Record<string, number> = {};
    const copy = output.transaction(() => {
      for (const sql of materializeSelectedTrackIdsSql(args.cut, REC_ELIGIBLE_WHERE)) {
        output.run(sql);
      }

      selectedTrackCount = countRows(output, "temp", "device_selected_track_ids");

      for (const table of DEVICE_SOURCE_TABLES) {
        expectedRowCounts[table] = countQuery(output, selectDeviceRowsSql(table, args.cut));
        output.run(insertDeviceTableSql(table, args.cut));
      }

      createIndexes(output);
      output
        .query(
          `INSERT INTO main.${quoteDeviceDbIdentifier("device_sync_meta")} (
            ${DEVICE_SYNC_META_COLUMNS.map(quoteDeviceDbIdentifier).join(", ")}
          ) VALUES (?, ?, ?, ?)`,
        )
        .run(DEVICE_DB_SCHEMA_VERSION, args.cut, derivedAt, sourceWatermark);
    });

    copy.immediate();
    expectedRowCounts.device_sync_meta = 1;
    runtime.afterCopy?.();
    assertClosure(output);
    preVacuumBytes = (await stat(temporaryOut)).size;

    output.run("DETACH DATABASE source");
    attached = false;
    output.run("VACUUM");
    output.close();

    const sourceWatermarkAfterDerivation = await sha256File(args.source);
    await assertStableSource(args.source);

    if (sourceWatermarkAfterDerivation !== sourceWatermark) {
      throw new Error("Source changed during derivation; discarded the inconsistent output.");
    }

    const validation = await validateDeviceArtifact(temporaryOut, {
      cut: args.cut,
      rowCounts: expectedRowCounts,
      sourceWatermark,
    });
    const publish = runtime.publish ?? publishDeviceArtifactAtomically;
    await publish(temporaryOut, args.out);
    published = true;

    return {
      ...validation,
      cut: args.cut,
      derivedAt,
      elapsedMs: Math.round(performance.now() - startedAt),
      out: args.out,
      preVacuumBytes,
      schemaVersion: DEVICE_DB_SCHEMA_VERSION,
      selectedTrackCount,
      source: args.source,
      sourceRowCounts,
      sourceWatermark,
    };
  } finally {
    if (attached) {
      try {
        output.run("DETACH DATABASE source");
      } catch {
        // Preserve the original derivation failure.
      }
    }

    try {
      output.close();
    } catch {
      // The handle is already closed on the verified publication path.
    }

    if (!published) {
      await removeDatabaseFiles(temporaryOut);
    }
  }
}

if (import.meta.main) {
  const result = await deriveDeviceDatabase(parseDeviceDerivationArgs(Bun.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}
