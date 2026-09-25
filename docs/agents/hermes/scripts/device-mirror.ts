#!/usr/bin/env bun

import { createClient, type Client, type Config, type Replicated } from "@libsql/client";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, mkdir, rmdir, rm, stat, utimes } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEVICE_DB_COLUMNS,
  DEVICE_DB_INDEXES,
  DEVICE_DB_PRIMARY_KEYS,
  DEVICE_DB_SCHEMA_VERSION,
  DEVICE_SOURCE_TABLES,
  DEVICE_SYNC_META_COLUMNS,
  type DeviceSourceTable,
  deviceDbClosureChecksSql,
  quoteDeviceDbIdentifier,
} from "./device-db-derivation";

export type DeviceSqlValue = ArrayBuffer | ArrayBufferView | bigint | number | string | null;
export type DeviceRow = Record<string, DeviceSqlValue>;

export type LibsqlStatement = {
  args?: readonly DeviceSqlValue[];
  sql: string;
};

export type QueryResult = {
  affectedRows: number;
  columns: string[];
  rows: DeviceSqlValue[][];
};

export type DeviceTargetClient = {
  batch(statements: readonly LibsqlStatement[], mode: "read" | "write"): Promise<QueryResult[]>;
};

export type DeviceGeneration = {
  artifactBytes: number;
  derivedAt: string;
  fingerprint: string;
  path: string;
  rowCounts: Record<DeviceSourceTable, number>;
};

export type StageMetrics = {
  maxBufferedRows: number;
  restarted: boolean;
  stagedRows: number;
};

export type DevicePublishPath = "delta" | "replay" | "rewrite";

export type DeviceRewriteReason =
  | "delta_over_threshold"
  | "delta_validation_mismatch"
  | "no_prior_generation"
  | "schema_change";

export type PublicationResult = StageMetrics & {
  backlogRows: number;
  deltaRows: number | null;
  publishPath: DevicePublishPath;
  published: boolean;
  replayed: boolean;
  rewriteReason: DeviceRewriteReason | null;
  stageRebuilt: boolean;
  stageRetained: boolean;
  writtenRows: number;
};

export type PublicationHooks = {
  afterCutover?: () => void | Promise<void>;
  beforeCutover?: () => void | Promise<void>;
  cutoverFailureAfterStatement?: number;
};

export type ReplicaSyncResult = {
  durationMs: number;
  frameNo: number | null;
  framesSynced: number;
  rebuildCause: string | null;
};

export function calculateReplicaLagFrames(
  sync: Pick<ReplicaSyncResult, "frameNo" | "framesSynced">,
): number | null {
  if (
    sync.frameNo === null ||
    !Number.isSafeInteger(sync.frameNo) ||
    sync.frameNo < 0 ||
    !Number.isSafeInteger(sync.framesSynced) ||
    sync.framesSynced < 0
  ) {
    return null;
  }

  return 0;
}

type StageControl = {
  artifactBytes: number;
  derivedAt: string;
  fingerprint: string;
  generation: string;
  rowCountsJson: string;
  schemaVersion: number;
  state: string;
};

type StageCheckpoint = {
  complete: boolean;
  lastKey: DeviceRow | null;
  uploadedRows: number;
};

type WireValue =
  | { type: "blob"; base64: string }
  | { type: "float"; value: number }
  | { type: "integer"; value: string }
  | { type: "null" }
  | { type: "text"; value: string };

type WireCell = {
  base64?: string;
  type: string;
  value?: number | string;
};

type WireStatementResult = {
  affected_row_count?: number;
  cols?: { name?: string }[];
  rows?: WireCell[][];
};

const EXPECTED_INTERVAL_MS = 3_600_000;

export function publishCadence(
  previousDerivedAt: string,
  nowMs: number,
  intervalMs: number,
  forced: boolean,
): { ageMs: number; due: boolean } {
  const previousTime = Date.parse(previousDerivedAt);
  if (!Number.isFinite(previousTime)) {
    return { ageMs: Number.POSITIVE_INFINITY, due: true };
  }
  const ageMs = Math.max(0, nowMs - previousTime);
  return { ageMs, due: forced || ageMs >= intervalMs };
}

export const DEFAULT_PUBLISH_INTERVAL_MS = 60 * 60 * 1000;

export const DEVICE_DELTA_MAX_SHARE = 0.05;

export const DEVICE_DELTA_MAX_ROWS = 5000;

export function deviceDeltaCeiling(totalRows: number): number {
  return Math.max(
    1,
    Math.min(DEVICE_DELTA_MAX_ROWS, Math.floor(totalRows * DEVICE_DELTA_MAX_SHARE)),
  );
}

export function isGenerationWatermark(watermark: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(watermark);
}
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;

const DEFAULT_LOCK_STALE_MS = 15 * 60 * 1000;

const LOCK_HEARTBEAT_MS = 60 * 1000;
const STAGE_CONTROL_TABLE = "_device_mirror_stage_control";
const STAGE_CHECKPOINT_TABLE = "_device_mirror_stage_checkpoint";
const REQUIRED_SOURCE_TABLES = [...DEVICE_SOURCE_TABLES, "track_embeddings"] as const;

const log = (message: string) => console.error(`[device-mirror] ${message}`);

function bytesOf(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function canonicalValue(value: DeviceSqlValue): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "bigint") {
    return `integer:${value}`;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Device fingerprint cannot encode a non-finite number");
    }

    return Number.isInteger(value)
      ? `integer:${Object.is(value, -0) ? "0" : String(value)}`
      : `float:${Object.is(value, -0) ? "0" : String(value)}`;
  }
  if (typeof value === "string") {
    return `text:${value.length}:${value}`;
  }

  return `blob:${Buffer.from(bytesOf(value)).toString("base64")}`;
}

function textCell(value: DeviceSqlValue | undefined, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected text from ${field}`);
  }

  return value;
}

function startContentFingerprint() {
  const hash = createHash("sha256");
  hash.update(`device-db-schema:${DEVICE_DB_SCHEMA_VERSION}\ncut:anchored\n`);
  return hash;
}

function addTableHeader(hash: ReturnType<typeof createHash>, table: DeviceSourceTable): void {
  hash.update(`table:${table}\ncolumns:${DEVICE_DB_COLUMNS[table].join(",")}\n`);
}

function addRowToFingerprint(
  hash: ReturnType<typeof createHash>,
  table: DeviceSourceTable,
  row: DeviceRow,
): void {
  for (const column of DEVICE_DB_COLUMNS[table]) {
    hash.update(`${column}=${canonicalValue(row[column] ?? null)}\n`);
  }
}

export function deviceRowDigest(table: DeviceSourceTable, row: DeviceRow): string {
  const hash = createHash("sha256");
  addTableHeader(hash, table);
  addRowToFingerprint(hash, table, row);
  return hash.digest("hex");
}

function rowFromCells(table: DeviceSourceTable, cells: readonly DeviceSqlValue[]): DeviceRow {
  const columns = DEVICE_DB_COLUMNS[table];

  if (cells.length !== columns.length) {
    throw new Error(`Unexpected ${table} row width: ${cells.length}`);
  }

  return Object.fromEntries(columns.map((column, index) => [column, cells[index] ?? null]));
}

function rowKeyObject(table: DeviceSourceTable, row: DeviceRow): DeviceRow {
  return Object.fromEntries(
    DEVICE_DB_PRIMARY_KEYS[table].map((column) => {
      const value = row[column];

      if (typeof value !== "string") {
        throw new Error(`Expected text primary key for ${table}.${column}`);
      }

      return [column, value];
    }),
  );
}

function stageTable(table: DeviceSourceTable): string {
  return `_device_mirror_stage_${table}`;
}

function stageTableSql(table: DeviceSourceTable): string {
  const columns = DEVICE_DB_COLUMNS[table].map(quoteDeviceDbIdentifier);
  const primaryKey = ["generation", ...DEVICE_DB_PRIMARY_KEYS[table]]
    .map(quoteDeviceDbIdentifier)
    .join(", ");

  return `CREATE TABLE IF NOT EXISTS ${quoteDeviceDbIdentifier(stageTable(table))} (
    ${quoteDeviceDbIdentifier("generation")} TEXT NOT NULL,
    ${columns.join(",\n    ")},
    PRIMARY KEY (${primaryKey})
  ) WITHOUT ROWID`;
}

export function createStageSchemaStatements(): readonly LibsqlStatement[] {
  return [
    {
      sql: `CREATE TABLE IF NOT EXISTS ${quoteDeviceDbIdentifier(STAGE_CONTROL_TABLE)} (
        singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
        generation TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        derived_at TEXT NOT NULL,
        artifact_bytes INTEGER NOT NULL,
        row_counts_json TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS ${quoteDeviceDbIdentifier(STAGE_CHECKPOINT_TABLE)} (
        table_name TEXT NOT NULL PRIMARY KEY,
        generation TEXT NOT NULL,
        uploaded_rows INTEGER NOT NULL,
        last_key_json TEXT,
        complete INTEGER NOT NULL
      )`,
    },
    ...DEVICE_SOURCE_TABLES.map((table) => ({ sql: stageTableSql(table) })),
  ];
}

async function readTableColumns(
  target: DeviceTargetClient,
  tables: readonly string[],
): Promise<Record<string, string[]>> {
  const results = await target.batch(
    tables.map((table) => ({
      sql: `PRAGMA table_info(${quoteDeviceDbIdentifier(table)})`,
    })),
    "read",
  );

  return Object.fromEntries(
    tables.map((table, index) => [
      table,
      (results[index]?.rows ?? []).map((row) => textCell(row[1], `PRAGMA table_info(${table})`)),
    ]),
  );
}

function sameColumns(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((column, index) => column === expected[index])
  );
}

async function validateLiveTargetSchema(target: DeviceTargetClient): Promise<void> {
  const tables = [...DEVICE_SOURCE_TABLES, "device_sync_meta"];
  const columns = await readTableColumns(target, tables);

  for (const table of DEVICE_SOURCE_TABLES) {
    if (!sameColumns(columns[table] ?? [], DEVICE_DB_COLUMNS[table])) {
      throw new Error(`Target device schema columns are incompatible for ${table}`);
    }
  }
  if (!sameColumns(columns.device_sync_meta ?? [], DEVICE_SYNC_META_COLUMNS)) {
    throw new Error("Target device_sync_meta columns are incompatible");
  }

  const [indexes] = await target.batch(
    [{ sql: "SELECT name FROM sqlite_master WHERE type = 'index'" }],
    "read",
  );
  const indexNames = new Set(
    (indexes?.rows ?? []).map((row) => textCell(row[0], "sqlite_master.index.name")),
  );

  for (const index of DEVICE_DB_INDEXES) {
    if (!indexNames.has(index.name)) {
      throw new Error(`Target device index is missing: ${index.name}`);
    }
  }
}

async function ensureStageSchema(target: DeviceTargetClient): Promise<boolean> {
  await target.batch(createStageSchemaStatements(), "write");
  const stageTables = DEVICE_SOURCE_TABLES.map(stageTable);
  const tables = [STAGE_CONTROL_TABLE, STAGE_CHECKPOINT_TABLE, ...stageTables];
  const columns = await readTableColumns(target, tables);
  const controlColumns = [
    "singleton",
    "generation",
    "fingerprint",
    "schema_version",
    "derived_at",
    "artifact_bytes",
    "row_counts_json",
    "state",
    "updated_at",
  ];
  const checkpointColumns = [
    "table_name",
    "generation",
    "uploaded_rows",
    "last_key_json",
    "complete",
  ];
  const valid =
    sameColumns(columns[STAGE_CONTROL_TABLE] ?? [], controlColumns) &&
    sameColumns(columns[STAGE_CHECKPOINT_TABLE] ?? [], checkpointColumns) &&
    DEVICE_SOURCE_TABLES.every((table) =>
      sameColumns(columns[stageTable(table)] ?? [], ["generation", ...DEVICE_DB_COLUMNS[table]]),
    );

  if (valid) {
    return false;
  }

  await target.batch(
    [
      ...stageTables.map((table) => ({
        sql: `DROP TABLE IF EXISTS ${quoteDeviceDbIdentifier(table)}`,
      })),
      { sql: `DROP TABLE IF EXISTS ${quoteDeviceDbIdentifier(STAGE_CHECKPOINT_TABLE)}` },
      { sql: `DROP TABLE IF EXISTS ${quoteDeviceDbIdentifier(STAGE_CONTROL_TABLE)}` },
      ...createStageSchemaStatements(),
    ],
    "write",
  );
  return true;
}

function wireValue(value: DeviceSqlValue): WireValue {
  if (value === null) {
    return { type: "null" };
  }
  if (typeof value === "bigint") {
    return { type: "integer", value: String(value) };
  }
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { type: "integer", value: String(value) }
      : { type: "float", value };
  }
  if (typeof value === "string") {
    return { type: "text", value };
  }

  return { base64: Buffer.from(bytesOf(value)).toString("base64"), type: "blob" };
}

function decodeCell(cell: WireCell): DeviceSqlValue {
  if (cell.type === "null") {
    return null;
  }
  if (cell.type === "integer") {
    return BigInt(String(cell.value ?? "0"));
  }
  if (cell.type === "float") {
    return Number(cell.value ?? 0);
  }
  if (cell.type === "blob") {
    return new Uint8Array(Buffer.from(cell.base64 ?? "", "base64"));
  }

  return String(cell.value ?? "");
}

function wireStatement(statement: LibsqlStatement) {
  return {
    args: (statement.args ?? []).map(wireValue),
    named_args: [],
    sql: statement.sql,
    want_rows: true,
  };
}

function conditionOk(step: number) {
  return { step, type: "ok" as const };
}

export class LibsqlHttpClient implements DeviceTargetClient {
  readonly #authToken: string;
  readonly #baseUrl: string;

  constructor(url: string, authToken: string) {
    this.#baseUrl = url.replace(/^libsql:\/\//, "https://").replace(/\/$/, "");
    this.#authToken = authToken;

    if (!/^https?:\/\//.test(this.#baseUrl)) {
      throw new Error("Target database URL must use libsql://, https://, or http://");
    }
  }

  async batch(
    statements: readonly LibsqlStatement[],
    mode: "read" | "write",
  ): Promise<QueryResult[]> {
    if (statements.length === 0) {
      return [];
    }

    const steps: {
      condition?:
        | ReturnType<typeof conditionOk>
        | { cond: ReturnType<typeof conditionOk>; type: "not" };
      stmt: ReturnType<typeof wireStatement>;
    }[] = [];
    const beginSql = mode === "read" ? "BEGIN TRANSACTION READONLY" : "BEGIN IMMEDIATE";

    steps.push({ stmt: wireStatement({ sql: beginSql }) });

    let lastStep = 0;
    for (const statement of statements) {
      steps.push({ condition: conditionOk(lastStep), stmt: wireStatement(statement) });
      lastStep = steps.length - 1;
    }

    const commitStep = steps.length;
    steps.push({ condition: conditionOk(lastStep), stmt: wireStatement({ sql: "COMMIT" }) });
    steps.push({
      condition: { cond: conditionOk(commitStep), type: "not" },
      stmt: wireStatement({ sql: "ROLLBACK" }),
    });

    const response = await fetch(`${this.#baseUrl}/v2/pipeline`, {
      body: JSON.stringify({
        requests: [{ batch: { steps }, type: "batch" }, { type: "close" }],
      }),
      headers: {
        Authorization: `Bearer ${this.#authToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(10 * 60_000),
    });

    if (!response.ok) {
      throw new Error(`libSQL target pipeline returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
      results?: Array<{
        error?: { code?: string };
        response?: {
          result?: {
            step_errors?: Array<{ code?: string } | null>;
            step_results?: Array<WireStatementResult | null>;
          };
          type?: string;
        };
        type?: string;
      }>;
    };
    const batchResult = payload.results?.[0];

    if (batchResult?.type === "error") {
      throw new Error(`libSQL target pipeline failed: ${batchResult.error?.code ?? "unknown"}`);
    }
    if (batchResult?.response?.type !== "batch" || !batchResult.response.result) {
      throw new Error("libSQL target pipeline returned no batch result");
    }

    const failedStep = (batchResult.response.result.step_errors ?? []).findIndex(
      (error) => error !== null,
    );

    if (failedStep >= 0) {
      const failure = batchResult.response.result.step_errors?.[failedStep];
      throw new Error(
        `libSQL target batch step ${failedStep} failed: ${failure?.code ?? "unknown"}`,
      );
    }

    const results = batchResult.response.result.step_results ?? [];

    if (!results[0] || !results[commitStep]) {
      throw new Error("libSQL target transaction did not commit");
    }

    return statements.map((_, index) => {
      const result = results[index + 1];

      if (!result) {
        throw new Error(`libSQL target batch step ${index + 1} did not execute`);
      }

      return {
        affectedRows: result.affected_row_count ?? 0,
        columns: (result.cols ?? []).map((column) => column.name ?? ""),
        rows: (result.rows ?? []).map((row) => row.map(decodeCell)),
      };
    });
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }

  return value;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];

  if (raw === undefined) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

async function removeReplicaFiles(path: string): Promise<void> {
  const paths = [path, `${path}-wal`, `${path}-shm`, `${path}-info`];
  await Promise.all(paths.map((candidate) => rm(candidate, { force: true })));
}

async function protectReplicaFiles(path: string): Promise<void> {
  const paths = [path, `${path}-wal`, `${path}-shm`, `${path}-info`];

  await Promise.all(
    paths.map(async (candidate) => {
      if (await stat(candidate).catch(() => undefined)) {
        await chmod(candidate, 0o600);
      }
    }),
  );
}

function validateReplicaFile(path: string): string | null {
  let database: Database;

  try {
    database = new Database(path, { readonly: true, strict: true });
  } catch {
    return "open_failed";
  }

  try {
    const quickCheck = database.query("PRAGMA quick_check").get() as {
      quick_check: string;
    } | null;

    if (quickCheck?.quick_check !== "ok") {
      return "quick_check_failed";
    }

    const tables = database.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[];
    const names = new Set(tables.map((row) => row.name));

    return REQUIRED_SOURCE_TABLES.every((table) => names.has(table)) ? null : "incomplete_schema";
  } catch {
    return "inspection_failed";
  } finally {
    database.close();
  }
}

function checkpointReplica(path: string): void {
  const database = new Database(path, { strict: true });

  try {
    database.run("PRAGMA wal_checkpoint(TRUNCATE)");
    const failure = validateReplicaFile(path);

    if (failure) {
      throw new Error(`Synced source replica is invalid: ${failure}`);
    }
  } finally {
    database.close();
  }
}

export async function syncSourceReplica(
  options: {
    authToken: string;
    forceRebuild?: boolean;
    path: string;
    syncUrl: string;
  },
  factory: (config: Config) => Pick<Client, "close" | "sync"> = createClient,
): Promise<ReplicaSyncResult> {
  const startedAt = performance.now();
  const replicaFile = await stat(options.path).catch(() => undefined);
  let rebuildCause = options.forceRebuild ? "full_rebuild" : null;

  if (!replicaFile && !rebuildCause) {
    rebuildCause = "missing";
  }
  if (replicaFile && !rebuildCause) {
    rebuildCause = validateReplicaFile(options.path);
  }
  if (rebuildCause) {
    await removeReplicaFiles(options.path);
  }

  const config: Config = {
    authToken: options.authToken,
    syncUrl: options.syncUrl,
    url: `file:${options.path}`,
  };
  let client: Pick<Client, "close" | "sync">;

  try {
    client = factory(config);
  } catch {
    rebuildCause = rebuildCause ?? "replica_metadata_corrupt";
    await removeReplicaFiles(options.path);
    client = factory(config);
  }

  let sync: Replicated;

  try {
    sync = await client.sync();
  } catch (error) {
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

    if (
      message.includes("corrupt") ||
      message.includes("metadata") ||
      message.includes("not a database") ||
      message.includes("sqlite_notadb")
    ) {
      await removeReplicaFiles(options.path);
    }

    throw error;
  } finally {
    client.close();
  }

  checkpointReplica(options.path);
  await protectReplicaFiles(options.path);

  return {
    durationMs: Math.round(performance.now() - startedAt),
    frameNo: sync?.frame_no ?? null,
    framesSynced: sync?.frames_synced ?? 0,
    rebuildCause,
  };
}

function defaultDeriverPath(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../apps/web/scripts/derive-device-db.ts",
  );
}

async function runDeriver(
  source: string,
  out: string,
): Promise<{
  bytes: number;
  derivedAt: string;
  elapsedMs: number;
  preVacuumBytes: number;
}> {
  const deriver = process.env.DEVICE_DERIVE_SCRIPT ?? defaultDeriverPath();
  const bun = process.env.BUN_BIN ?? process.execPath;
  const processResult = Bun.spawn(
    [bun, deriver, "--source", source, "--out", out, "--cut", "anchored"],
    {
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    processResult.exited,
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `Local device derivation failed: ${stderr.trim().slice(0, 400) || `exit ${exitCode}`}`,
    );
  }

  const result = JSON.parse(stdout) as {
    bytes?: number;
    derivedAt?: string;
    elapsedMs?: number;
    preVacuumBytes?: number;
    validation?: string;
  };

  if (
    result.validation !== "verified" ||
    typeof result.bytes !== "number" ||
    typeof result.derivedAt !== "string" ||
    typeof result.elapsedMs !== "number" ||
    typeof result.preVacuumBytes !== "number"
  ) {
    throw new Error("Local device deriver returned an invalid validation summary");
  }

  return {
    bytes: result.bytes,
    derivedAt: result.derivedAt,
    elapsedMs: result.elapsedMs,
    preVacuumBytes: result.preVacuumBytes,
  };
}

export function inspectDeviceGeneration(path: string): DeviceGeneration {
  const database = new Database(path, { readonly: true, strict: true });
  const hash = startContentFingerprint();
  const rowCounts = {} as Record<DeviceSourceTable, number>;
  let derivedAt = "";

  try {
    const meta = database
      .query("SELECT schema_version, cut_name, derived_at FROM device_sync_meta ORDER BY rowid")
      .all() as { cut_name: string; derived_at: string; schema_version: number }[];

    if (
      meta.length !== 1 ||
      meta[0]?.schema_version !== DEVICE_DB_SCHEMA_VERSION ||
      meta[0]?.cut_name !== "anchored"
    ) {
      throw new Error("Local device generation metadata is incompatible");
    }

    derivedAt = meta[0].derived_at;

    for (const table of DEVICE_SOURCE_TABLES) {
      addTableHeader(hash, table);
      const columns = DEVICE_DB_COLUMNS[table].map(quoteDeviceDbIdentifier).join(", ");
      const order = DEVICE_DB_PRIMARY_KEYS[table].map(quoteDeviceDbIdentifier).join(", ");
      let count = 0;

      for (const row of database
        .query(`SELECT ${columns} FROM ${quoteDeviceDbIdentifier(table)} ORDER BY ${order}`)
        .iterate() as Iterable<DeviceRow>) {
        addRowToFingerprint(hash, table, row);
        count += 1;
      }

      rowCounts[table] = count;
    }

    for (const check of deviceDbClosureChecksSql()) {
      const result = database.query(check.sql).get() as { count: number | bigint } | null;

      if (Number(result?.count ?? -1) !== 0) {
        throw new Error(`Local device generation violates ${check.edge}`);
      }
    }
  } finally {
    database.close();
  }

  const file = Bun.file(path);

  return {
    artifactBytes: file.size,
    derivedAt,
    fingerprint: `sha256:${hash.digest("hex")}`,
    path,
    rowCounts,
  };
}

function generationCountsJson(generation: DeviceGeneration): string {
  return JSON.stringify(
    Object.fromEntries(DEVICE_SOURCE_TABLES.map((table) => [table, generation.rowCounts[table]])),
  );
}

async function readStageControl(target: DeviceTargetClient): Promise<StageControl | null> {
  const [result] = await target.batch(
    [
      {
        sql: `SELECT generation, fingerprint, schema_version, derived_at, artifact_bytes,
          row_counts_json, state FROM ${quoteDeviceDbIdentifier(STAGE_CONTROL_TABLE)}
          WHERE singleton = 1`,
      },
    ],
    "read",
  );
  const row = result?.rows[0];

  if (!row) {
    return null;
  }

  return {
    artifactBytes: Number(row[4]),
    derivedAt: textCell(row[3], "stage.derived_at"),
    fingerprint: textCell(row[1], "stage.fingerprint"),
    generation: textCell(row[0], "stage.generation"),
    rowCountsJson: textCell(row[5], "stage.row_counts_json"),
    schemaVersion: Number(row[2]),
    state: textCell(row[6], "stage.state"),
  };
}

function stageMatches(control: StageControl | null, generation: DeviceGeneration): boolean {
  return (
    control?.generation === generation.fingerprint &&
    control.fingerprint === generation.fingerprint &&
    control.schemaVersion === DEVICE_DB_SCHEMA_VERSION &&
    control.derivedAt === generation.derivedAt &&
    control.artifactBytes === generation.artifactBytes &&
    control.rowCountsJson === generationCountsJson(generation) &&
    (control.state === "uploading" || control.state === "verified")
  );
}

async function resetStage(target: DeviceTargetClient, generation: DeviceGeneration): Promise<void> {
  const now = new Date().toISOString();
  const statements: LibsqlStatement[] = [
    ...DEVICE_SOURCE_TABLES.map((table) => ({
      sql: `DELETE FROM ${quoteDeviceDbIdentifier(stageTable(table))}`,
    })),
    { sql: `DELETE FROM ${quoteDeviceDbIdentifier(STAGE_CHECKPOINT_TABLE)}` },
    {
      args: [
        generation.fingerprint,
        generation.fingerprint,
        DEVICE_DB_SCHEMA_VERSION,
        generation.derivedAt,
        generation.artifactBytes,
        generationCountsJson(generation),
        "uploading",
        now,
      ],
      sql: `INSERT INTO ${quoteDeviceDbIdentifier(STAGE_CONTROL_TABLE)}
        (singleton, generation, fingerprint, schema_version, derived_at, artifact_bytes,
         row_counts_json, state, updated_at)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (singleton) DO UPDATE SET
          generation = excluded.generation,
          fingerprint = excluded.fingerprint,
          schema_version = excluded.schema_version,
          derived_at = excluded.derived_at,
          artifact_bytes = excluded.artifact_bytes,
          row_counts_json = excluded.row_counts_json,
          state = excluded.state,
          updated_at = excluded.updated_at`,
    },
    ...DEVICE_SOURCE_TABLES.map((table) => ({
      args: [table, generation.fingerprint],
      sql: `INSERT INTO ${quoteDeviceDbIdentifier(STAGE_CHECKPOINT_TABLE)}
        (table_name, generation, uploaded_rows, last_key_json, complete)
        VALUES (?, ?, 0, NULL, 0)`,
    })),
  ];

  await target.batch(statements, "write");
}

async function readCheckpoint(
  target: DeviceTargetClient,
  table: DeviceSourceTable,
  generation: string,
): Promise<StageCheckpoint> {
  const [result] = await target.batch(
    [
      {
        args: [table, generation],
        sql: `SELECT uploaded_rows, last_key_json, complete
          FROM ${quoteDeviceDbIdentifier(STAGE_CHECKPOINT_TABLE)}
          WHERE table_name = ? AND generation = ?`,
      },
    ],
    "read",
  );
  const row = result?.rows[0];

  if (!row) {
    throw new Error(`Missing stage checkpoint for ${table}`);
  }

  let lastKey: DeviceRow | null = null;

  if (typeof row[1] === "string") {
    const parsed = JSON.parse(row[1]) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid stage checkpoint key for ${table}`);
    }

    lastKey = parsed as DeviceRow;
    rowKeyObject(table, lastKey);
  }

  return {
    complete: Number(row[2]) === 1,
    lastKey,
    uploadedRows: Number(row[0]),
  };
}

function keysetClause(
  table: DeviceSourceTable,
  alias: string,
  lastKey: DeviceRow | null,
): { args: DeviceSqlValue[]; sql: string } {
  if (!lastKey) {
    return { args: [], sql: "" };
  }

  const keys = DEVICE_DB_PRIMARY_KEYS[table];
  const branches: string[] = [];
  const args: DeviceSqlValue[] = [];

  keys.forEach((key, index) => {
    const equals = keys.slice(0, index).map((prefix) => {
      args.push(lastKey[prefix] ?? null);
      return `${alias}.${quoteDeviceDbIdentifier(prefix)} = ?`;
    });
    args.push(lastKey[key] ?? null);
    branches.push(`(${[...equals, `${alias}.${quoteDeviceDbIdentifier(key)} > ?`].join(" AND ")})`);
  });

  return { args, sql: ` AND (${branches.join(" OR ")})` };
}

function readLocalPage(
  database: Database,
  table: DeviceSourceTable,
  lastKey: DeviceRow | null,
  limit: number,
): DeviceRow[] {
  const columns = DEVICE_DB_COLUMNS[table].map(quoteDeviceDbIdentifier).join(", ");
  const order = DEVICE_DB_PRIMARY_KEYS[table].map(quoteDeviceDbIdentifier).join(", ");
  const keyset = keysetClause(table, "source_row", lastKey);

  return database
    .query(
      `SELECT ${columns} FROM ${quoteDeviceDbIdentifier(table)} AS source_row
       WHERE 1 = 1${keyset.sql} ORDER BY ${order} LIMIT ?`,
    )
    .all(...keyset.args, limit) as DeviceRow[];
}

function stageRowStatement(
  table: DeviceSourceTable,
  generation: string,
  row: DeviceRow,
): LibsqlStatement {
  const columns = DEVICE_DB_COLUMNS[table];
  const allColumns = ["generation", ...columns];
  const conflict = ["generation", ...DEVICE_DB_PRIMARY_KEYS[table]]
    .map(quoteDeviceDbIdentifier)
    .join(", ");
  const mutable = columns.filter((column) => !DEVICE_DB_PRIMARY_KEYS[table].includes(column));

  return {
    args: [generation, ...columns.map((column) => row[column] ?? null)],
    sql: `INSERT INTO ${quoteDeviceDbIdentifier(stageTable(table))}
      (${allColumns.map(quoteDeviceDbIdentifier).join(", ")})
      VALUES (${allColumns.map(() => "?").join(", ")})
      ON CONFLICT (${conflict}) DO UPDATE SET
      ${mutable
        .map(
          (column) =>
            `${quoteDeviceDbIdentifier(column)} = excluded.${quoteDeviceDbIdentifier(column)}`,
        )
        .join(", ")}`,
  };
}

async function uploadStage(
  target: DeviceTargetClient,
  generation: DeviceGeneration,
  pageSize: number,
): Promise<StageMetrics> {
  const database = new Database(generation.path, { readonly: true, strict: true });
  let maxBufferedRows = 0;
  let restarted = false;
  let stagedRows = 0;

  try {
    for (const table of DEVICE_SOURCE_TABLES) {
      let checkpoint = await readCheckpoint(target, table, generation.fingerprint);

      if (checkpoint.complete) {
        restarted = true;
        stagedRows += checkpoint.uploadedRows;
        continue;
      }
      if (checkpoint.uploadedRows > 0) {
        restarted = true;
        stagedRows += checkpoint.uploadedRows;
      }

      while (true) {
        const page = readLocalPage(database, table, checkpoint.lastKey, pageSize);
        maxBufferedRows = Math.max(maxBufferedRows, page.length);

        if (page.length === 0) {
          await target.batch(
            [
              {
                args: [table, generation.fingerprint, checkpoint.uploadedRows],
                sql: `UPDATE ${quoteDeviceDbIdentifier(STAGE_CHECKPOINT_TABLE)} SET complete = 1
                  WHERE table_name = ? AND generation = ? AND uploaded_rows = ?`,
              },
            ],
            "write",
          );
          break;
        }

        const finalRow = page[page.length - 1];

        if (!finalRow) {
          throw new Error(`Missing final ${table} row in non-empty stage page`);
        }

        const lastKey = rowKeyObject(table, finalRow);
        const uploadedRows = checkpoint.uploadedRows + page.length;
        const statements = page.map((row) => stageRowStatement(table, generation.fingerprint, row));
        statements.push({
          args: [
            uploadedRows,
            JSON.stringify(lastKey),
            table,
            generation.fingerprint,
            checkpoint.uploadedRows,
          ],
          sql: `UPDATE ${quoteDeviceDbIdentifier(STAGE_CHECKPOINT_TABLE)}
            SET uploaded_rows = ?, last_key_json = ?
            WHERE table_name = ? AND generation = ? AND uploaded_rows = ?`,
        });
        const results = await target.batch(statements, "write");
        const checkpointResult = results[results.length - 1];

        if (checkpointResult?.affectedRows !== 1) {
          throw new Error(`Stage checkpoint race for ${table}`);
        }

        checkpoint = { complete: false, lastKey, uploadedRows };
        stagedRows += page.length;
      }
    }
  } finally {
    database.close();
  }

  return { maxBufferedRows, restarted, stagedRows };
}

function stageClosureStatements(generation: string): readonly LibsqlStatement[] {
  const table = (name: DeviceSourceTable) => quoteDeviceDbIdentifier(stageTable(name));
  const checks = [
    `SELECT count(*) AS count FROM ${table("findings")} child
      LEFT JOIN ${table("tracks")} parent ON parent.generation = child.generation
        AND parent.track_id = child.track_id
      WHERE child.generation = ? AND parent.track_id IS NULL`,
    `SELECT count(*) AS count FROM ${table("track_artists")} child
      LEFT JOIN ${table("tracks")} parent ON parent.generation = child.generation
        AND parent.track_id = child.track_id
      WHERE child.generation = ? AND parent.track_id IS NULL`,
    `SELECT count(*) AS count FROM ${table("track_artists")} child
      LEFT JOIN ${table("artists")} parent ON parent.generation = child.generation
        AND parent.id = child.artist_id
      WHERE child.generation = ? AND parent.id IS NULL`,
    `SELECT count(*) AS count FROM ${table("tracks")} child
      LEFT JOIN ${table("albums")} parent ON parent.generation = child.generation
        AND parent.id = child.album_id
      WHERE child.generation = ? AND child.album_id IS NOT NULL AND parent.id IS NULL`,
    `SELECT count(*) AS count FROM ${table("tracks")} child
      LEFT JOIN ${table("labels")} parent ON parent.generation = child.generation
        AND parent.id = child.label_id
      WHERE child.generation = ? AND child.label_id IS NOT NULL AND parent.id IS NULL`,
    `SELECT count(*) AS count FROM ${table("labels")} child
      LEFT JOIN ${table("labels")} parent ON parent.generation = child.generation
        AND parent.id = child.parent_label_id
      WHERE child.generation = ? AND child.parent_label_id IS NOT NULL AND parent.id IS NULL`,
  ];

  return checks.map((sql) => ({ args: [generation], sql }));
}

async function fingerprintStage(
  target: DeviceTargetClient,
  generation: string,
  pageSize: number,
): Promise<{ fingerprint: string; maxBufferedRows: number }> {
  const hash = startContentFingerprint();
  let maxBufferedRows = 0;

  for (const table of DEVICE_SOURCE_TABLES) {
    addTableHeader(hash, table);
    let lastKey: DeviceRow | null = null;

    while (true) {
      const columns = DEVICE_DB_COLUMNS[table]
        .map((column) => `stage.${quoteDeviceDbIdentifier(column)}`)
        .join(", ");
      const order = DEVICE_DB_PRIMARY_KEYS[table]
        .map((column) => `stage.${quoteDeviceDbIdentifier(column)}`)
        .join(", ");
      const keyset = keysetClause(table, "stage", lastKey);
      const [result] = await target.batch(
        [
          {
            args: [generation, ...keyset.args, pageSize],
            sql: `SELECT ${columns}
              FROM ${quoteDeviceDbIdentifier(stageTable(table))} AS stage
              WHERE stage.generation = ?${keyset.sql}
              ORDER BY ${order} LIMIT ?`,
          },
        ],
        "read",
      );
      const rows = (result?.rows ?? []).map((cells) => rowFromCells(table, cells));
      maxBufferedRows = Math.max(maxBufferedRows, rows.length);

      for (const row of rows) {
        addRowToFingerprint(hash, table, row);
      }

      if (rows.length < pageSize) {
        break;
      }

      const finalRow = rows[rows.length - 1];

      if (!finalRow) {
        throw new Error(`Missing final ${table} row in stage verification page`);
      }

      lastKey = rowKeyObject(table, finalRow);
    }
  }

  return { fingerprint: `sha256:${hash.digest("hex")}`, maxBufferedRows };
}

async function verifyStage(
  target: DeviceTargetClient,
  generation: DeviceGeneration,
  pageSize: number,
): Promise<number> {
  const countStatements = DEVICE_SOURCE_TABLES.map((table) => ({
    args: [generation.fingerprint],
    sql: `SELECT count(*) AS count FROM ${quoteDeviceDbIdentifier(stageTable(table))}
      WHERE generation = ?`,
  }));
  const results = await target.batch(
    [...countStatements, ...stageClosureStatements(generation.fingerprint)],
    "read",
  );

  DEVICE_SOURCE_TABLES.forEach((table, index) => {
    const actual = Number(results[index]?.rows[0]?.[0] ?? -1);

    if (actual !== generation.rowCounts[table]) {
      throw new Error(`Stage row count mismatch for ${table}: ${actual}`);
    }
  });

  results.slice(DEVICE_SOURCE_TABLES.length).forEach((result, index) => {
    const violations = Number(result.rows[0]?.[0] ?? -1);

    if (violations !== 0) {
      throw new Error(`Stage reachability check ${index + 1} failed: ${violations}`);
    }
  });

  const fingerprint = await fingerprintStage(target, generation.fingerprint, pageSize);

  if (fingerprint.fingerprint !== generation.fingerprint) {
    throw new Error("Stage content fingerprint mismatch");
  }

  const [marked] = await target.batch(
    [
      {
        args: [new Date().toISOString(), generation.fingerprint, generation.fingerprint],
        sql: `UPDATE ${quoteDeviceDbIdentifier(STAGE_CONTROL_TABLE)}
          SET state = 'verified', updated_at = ?
          WHERE singleton = 1 AND generation = ? AND fingerprint = ?`,
      },
    ],
    "write",
  );

  if (marked?.affectedRows !== 1) {
    throw new Error("Verified stage control row changed unexpectedly");
  }

  return fingerprint.maxBufferedRows;
}

async function stageAndVerify(
  target: DeviceTargetClient,
  generation: DeviceGeneration,
  pageSize: number,
): Promise<StageMetrics & { rebuilt: boolean }> {
  let aggregate: StageMetrics = { maxBufferedRows: 0, restarted: false, stagedRows: 0 };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const control = await readStageControl(target);
    const matching = attempt === 0 && stageMatches(control, generation);

    if (!matching) {
      await resetStage(target, generation);
    }

    const upload = await uploadStage(target, generation, pageSize);
    aggregate = {
      maxBufferedRows: Math.max(aggregate.maxBufferedRows, upload.maxBufferedRows),
      restarted: aggregate.restarted || matching || upload.restarted,
      stagedRows: aggregate.stagedRows + upload.stagedRows,
    };

    try {
      const verifyPeak = await verifyStage(target, generation, pageSize);
      aggregate.maxBufferedRows = Math.max(aggregate.maxBufferedRows, verifyPeak);
      return { ...aggregate, rebuilt: attempt > 0 || !matching };
    } catch (error) {
      if (attempt === 1) {
        throw error;
      }

      log(`discarding invalid stage: ${error instanceof Error ? error.message : String(error)}`);
      await resetStage(target, generation);
    }
  }

  throw new Error("Stage verification exhausted its rebuild attempt");
}

async function readTargetMeta(target: DeviceTargetClient): Promise<{
  derivedAt: string;
  sourceWatermark: string;
}> {
  const [result] = await target.batch(
    [
      {
        sql: `SELECT schema_version, cut_name, derived_at, source_watermark
          FROM device_sync_meta ORDER BY rowid`,
      },
    ],
    "read",
  );

  if (!result || result.rows.length !== 1) {
    throw new Error("Target device_sync_meta must contain exactly one row");
  }

  const row = result.rows[0];

  if (!row) {
    throw new Error("Target device_sync_meta row is missing");
  }

  if (Number(row[0]) !== DEVICE_DB_SCHEMA_VERSION || row[1] !== "anchored") {
    throw new Error("Target device schema version or cut is incompatible");
  }

  return {
    derivedAt: textCell(row[2], "device_sync_meta.derived_at"),
    sourceWatermark: textCell(row[3], "device_sync_meta.source_watermark"),
  };
}

function nullSafeDifference(table: DeviceSourceTable, left: string, right: string): string {
  return DEVICE_DB_COLUMNS[table]
    .map(
      (column) =>
        `${left}.${quoteDeviceDbIdentifier(column)} IS NOT ${right}.${quoteDeviceDbIdentifier(column)}`,
    )
    .join(" OR ");
}

function keyEquality(table: DeviceSourceTable, left: string, right: string): string {
  return DEVICE_DB_PRIMARY_KEYS[table]
    .map(
      (column) =>
        `${left}.${quoteDeviceDbIdentifier(column)} = ${right}.${quoteDeviceDbIdentifier(column)}`,
    )
    .join(" AND ");
}

async function measureBacklog(
  target: DeviceTargetClient,
  generation: DeviceGeneration,
): Promise<number> {
  const statements = DEVICE_SOURCE_TABLES.map((table) => {
    const stage = quoteDeviceDbIdentifier(stageTable(table));
    const live = quoteDeviceDbIdentifier(table);
    const firstKey = quoteDeviceDbIdentifier(DEVICE_DB_PRIMARY_KEYS[table][0] ?? "");

    return {
      args: [generation.fingerprint, generation.fingerprint],
      sql: `SELECT
        (SELECT count(*) FROM ${stage} AS stage
          LEFT JOIN ${live} AS live ON ${keyEquality(table, "stage", "live")}
          WHERE stage.generation = ?
            AND (live.${firstKey} IS NULL OR ${nullSafeDifference(table, "stage", "live")}))
        +
        (SELECT count(*) FROM ${live} AS live
          LEFT JOIN ${stage} AS stage ON stage.generation = ?
            AND ${keyEquality(table, "stage", "live")}
          WHERE stage.${firstKey} IS NULL) AS count`,
    };
  });
  const results = await target.batch(statements, "read");

  return results.reduce((total, result) => total + Number(result.rows[0]?.[0] ?? 0), 0);
}

const DEVICE_DELETE_ORDER = [
  "track_artists",
  "findings",
  "tracks",
  "artists",
  "labels",
  "albums",
] as const satisfies readonly DeviceSourceTable[];

const DEVICE_UPSERT_ORDER = [
  "albums",
  "artists",
  "labels",
  "tracks",
  "findings",
  "track_artists",
] as const satisfies readonly DeviceSourceTable[];

export type DeviceTableDelta = {
  deletes: DeviceRow[];

  upserts: DeviceRow[];
};

export type DeviceDelta = {
  deletes: number;

  fingerprint: string;
  inserts: number;
  maxBufferedRows: number;
  rows: number;
  tables: Record<DeviceSourceTable, DeviceTableDelta>;
  updates: number;
};

export type DeviceDeltaScan =
  | { delta: DeviceDelta; kind: "delta" }
  | { kind: "over-threshold"; maxBufferedRows: number };

function compareKeyTuples(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const comparison = Buffer.compare(
      Buffer.from(left[index] ?? "", "utf8"),
      Buffer.from(right[index] ?? "", "utf8"),
    );

    if (comparison !== 0) {
      return comparison;
    }
  }

  return 0;
}

function keyTuple(table: DeviceSourceTable, row: DeviceRow): string[] {
  const key = rowKeyObject(table, row);

  return DEVICE_DB_PRIMARY_KEYS[table].map((column) => {
    const value = key[column];

    return typeof value === "string" ? value : "";
  });
}

async function readLivePage(
  target: DeviceTargetClient,
  table: DeviceSourceTable,
  lastKey: DeviceRow | null,
  limit: number,
): Promise<DeviceRow[]> {
  const columns = DEVICE_DB_COLUMNS[table]
    .map((column) => `live.${quoteDeviceDbIdentifier(column)}`)
    .join(", ");
  const order = DEVICE_DB_PRIMARY_KEYS[table]
    .map((column) => `live.${quoteDeviceDbIdentifier(column)}`)
    .join(", ");
  const keyset = keysetClause(table, "live", lastKey);
  const [result] = await target.batch(
    [
      {
        args: [...keyset.args, limit],
        sql: `SELECT ${columns} FROM ${quoteDeviceDbIdentifier(table)} AS live
          WHERE 1 = 1${keyset.sql} ORDER BY ${order} LIMIT ?`,
      },
    ],
    "read",
  );

  return (result?.rows ?? []).map((cells) => rowFromCells(table, cells));
}

export async function computeDeviceDelta(
  target: DeviceTargetClient,
  generation: DeviceGeneration,
  pageSize: number,
  ceiling: number,
): Promise<DeviceDeltaScan> {
  const database = new Database(generation.path, { readonly: true, strict: true });
  const hash = startContentFingerprint();
  const tables = {} as Record<DeviceSourceTable, DeviceTableDelta>;
  let maxBufferedRows = 0;
  let deletes = 0;
  let inserts = 0;
  let updates = 0;

  try {
    for (const table of DEVICE_SOURCE_TABLES) {
      addTableHeader(hash, table);
      const tableDelta: DeviceTableDelta = { deletes: [], upserts: [] };
      tables[table] = tableDelta;

      const columns = DEVICE_DB_COLUMNS[table].map(quoteDeviceDbIdentifier).join(", ");
      const order = DEVICE_DB_PRIMARY_KEYS[table].map(quoteDeviceDbIdentifier).join(", ");
      const localRows = database
        .query(`SELECT ${columns} FROM ${quoteDeviceDbIdentifier(table)} ORDER BY ${order}`)
        .iterate() as Iterable<DeviceRow>;
      const localCursor = localRows[Symbol.iterator]();

      let livePage: DeviceRow[] = [];
      let liveIndex = 0;
      let liveLastKey: DeviceRow | null = null;
      let liveExhausted = false;

      const nextLive = async (): Promise<DeviceRow | null> => {
        if (liveIndex >= livePage.length) {
          if (liveExhausted) {
            return null;
          }

          livePage = await readLivePage(target, table, liveLastKey, pageSize);
          liveIndex = 0;
          maxBufferedRows = Math.max(maxBufferedRows, livePage.length);

          if (livePage.length < pageSize) {
            liveExhausted = true;
          }
          if (livePage.length === 0) {
            return null;
          }

          const finalRow = livePage[livePage.length - 1];

          if (!finalRow) {
            throw new Error(`Missing final ${table} row in live delta page`);
          }

          liveLastKey = rowKeyObject(table, finalRow);
        }

        const row = livePage[liveIndex] ?? null;
        liveIndex += 1;
        return row;
      };

      let localRow = localCursor.next();
      let liveRow = await nextLive();

      while (!localRow.done || liveRow !== null) {
        const localKey = localRow.done ? null : keyTuple(table, localRow.value);
        const liveKey = liveRow === null ? null : keyTuple(table, liveRow);
        const comparison =
          localKey === null ? 1 : liveKey === null ? -1 : compareKeyTuples(localKey, liveKey);

        if (comparison < 0 && !localRow.done) {
          addRowToFingerprint(hash, table, localRow.value);
          tableDelta.upserts.push(localRow.value);
          inserts += 1;
          localRow = localCursor.next();
        } else if (comparison > 0 && liveRow !== null) {
          tableDelta.deletes.push(rowKeyObject(table, liveRow));
          deletes += 1;
          liveRow = await nextLive();
        } else if (!localRow.done && liveRow !== null) {
          addRowToFingerprint(hash, table, localRow.value);

          if (deviceRowDigest(table, localRow.value) !== deviceRowDigest(table, liveRow)) {
            tableDelta.upserts.push(localRow.value);
            updates += 1;
          }

          localRow = localCursor.next();
          liveRow = await nextLive();
        }

        if (inserts + updates + deletes > ceiling) {
          return { kind: "over-threshold", maxBufferedRows };
        }
      }
    }
  } finally {
    database.close();
  }

  return {
    delta: {
      deletes,
      fingerprint: `sha256:${hash.digest("hex")}`,
      inserts,
      maxBufferedRows,
      rows: inserts + updates + deletes,
      tables,
      updates,
    },
    kind: "delta",
  };
}

function deleteRowStatement(table: DeviceSourceTable, key: DeviceRow): LibsqlStatement {
  const keys = DEVICE_DB_PRIMARY_KEYS[table];

  return {
    args: keys.map((column) => key[column] ?? null),
    sql: `DELETE FROM ${quoteDeviceDbIdentifier(table)}
      WHERE ${keys.map((column) => `${quoteDeviceDbIdentifier(column)} = ?`).join(" AND ")}`,
  };
}

function upsertRowStatement(table: DeviceSourceTable, row: DeviceRow): LibsqlStatement {
  const columns = DEVICE_DB_COLUMNS[table];
  const keys = DEVICE_DB_PRIMARY_KEYS[table];
  const mutable = columns.filter((column) => !keys.includes(column));

  return {
    args: columns.map((column) => row[column] ?? null),
    sql: `INSERT INTO ${quoteDeviceDbIdentifier(table)}
      (${columns.map(quoteDeviceDbIdentifier).join(", ")})
      VALUES (${columns.map(() => "?").join(", ")})
      ON CONFLICT (${keys.map(quoteDeviceDbIdentifier).join(", ")}) DO UPDATE SET
      ${mutable
        .map(
          (column) =>
            `${quoteDeviceDbIdentifier(column)} = excluded.${quoteDeviceDbIdentifier(column)}`,
        )
        .join(", ")}`,
  };
}

export function deviceDeltaStatements(
  generation: DeviceGeneration,
  delta: DeviceDelta,
): readonly LibsqlStatement[] {
  const statements: LibsqlStatement[] = [];

  for (const table of DEVICE_DELETE_ORDER) {
    for (const key of delta.tables[table].deletes) {
      statements.push(deleteRowStatement(table, key));
    }
  }
  for (const table of DEVICE_UPSERT_ORDER) {
    for (const row of delta.tables[table].upserts) {
      statements.push(upsertRowStatement(table, row));
    }
  }

  statements.push({
    args: [generation.derivedAt, generation.fingerprint, DEVICE_DB_SCHEMA_VERSION, "anchored"],
    sql: `UPDATE device_sync_meta SET derived_at = ?, source_watermark = ?
      WHERE schema_version = ? AND cut_name = ?`,
  });

  return statements;
}

export async function applyDeviceDelta(
  target: DeviceTargetClient,
  generation: DeviceGeneration,
  delta: DeviceDelta,
): Promise<number> {
  const statements = deviceDeltaStatements(generation, delta);
  const results = await target.batch(statements, "write");
  const metadataResult = results[results.length - 1];

  if (metadataResult?.affectedRows !== 1) {
    throw new Error("Device delta metadata did not update exactly once");
  }

  return results
    .slice(0, results.length - 1)
    .reduce((total, result) => total + result.affectedRows, 0);
}

function deleteLiveStatement(table: DeviceSourceTable, generation: string): LibsqlStatement {
  return {
    args: [generation],
    sql: `DELETE FROM ${quoteDeviceDbIdentifier(table)} AS live
      WHERE NOT EXISTS (
        SELECT 1 FROM ${quoteDeviceDbIdentifier(stageTable(table))} AS stage
        WHERE stage.generation = ? AND ${keyEquality(table, "stage", "live")}
      )`,
  };
}

function upsertLiveStatement(table: DeviceSourceTable, generation: string): LibsqlStatement {
  const columns = DEVICE_DB_COLUMNS[table];
  const keys = DEVICE_DB_PRIMARY_KEYS[table];
  const mutable = columns.filter((column) => !keys.includes(column));

  return {
    args: [generation],
    sql: `INSERT INTO ${quoteDeviceDbIdentifier(table)}
      (${columns.map(quoteDeviceDbIdentifier).join(", ")})
      SELECT ${columns.map((column) => `stage.${quoteDeviceDbIdentifier(column)}`).join(", ")}
      FROM ${quoteDeviceDbIdentifier(stageTable(table))} AS stage
      WHERE stage.generation = ?
      ORDER BY ${keys.map((column) => `stage.${quoteDeviceDbIdentifier(column)}`).join(", ")}
      ON CONFLICT (${keys.map(quoteDeviceDbIdentifier).join(", ")}) DO UPDATE SET
        ${mutable
          .map(
            (column) =>
              `${quoteDeviceDbIdentifier(column)} = excluded.${quoteDeviceDbIdentifier(column)}`,
          )
          .join(", ")}
      WHERE ${mutable
        .map(
          (column) =>
            `${quoteDeviceDbIdentifier(table)}.${quoteDeviceDbIdentifier(column)} IS NOT excluded.${quoteDeviceDbIdentifier(column)}`,
        )
        .join(" OR ")}`,
  };
}

export async function cutoverDeviceGeneration(
  target: DeviceTargetClient,
  generation: DeviceGeneration,
  failureAfterStatement?: number,
): Promise<number> {
  const statements: LibsqlStatement[] = [];

  for (const table of DEVICE_DELETE_ORDER) {
    statements.push(deleteLiveStatement(table, generation.fingerprint));
  }
  for (const table of DEVICE_UPSERT_ORDER) {
    statements.push(upsertLiveStatement(table, generation.fingerprint));
  }

  statements.push({
    args: [generation.derivedAt, generation.fingerprint, DEVICE_DB_SCHEMA_VERSION, "anchored"],
    sql: `UPDATE device_sync_meta SET derived_at = ?, source_watermark = ?
      WHERE schema_version = ? AND cut_name = ?`,
  });
  statements.push({
    args: [new Date().toISOString(), generation.fingerprint],
    sql: `UPDATE ${quoteDeviceDbIdentifier(STAGE_CONTROL_TABLE)}
      SET state = 'published', updated_at = ? WHERE singleton = 1 AND generation = ?`,
  });

  if (failureAfterStatement !== undefined) {
    statements.splice(failureAfterStatement, 0, { sql: "SELECT * FROM device_cutover_failure" });
  }

  const results = await target.batch(statements, "write");
  const metadataResult = results[results.length - 2];
  const controlResult = results[results.length - 1];

  if (metadataResult?.affectedRows !== 1 || controlResult?.affectedRows !== 1) {
    throw new Error("Atomic device cutover metadata did not update exactly once");
  }

  return results.slice(0, 12).reduce((total, result) => total + result.affectedRows, 0);
}

async function validatePublishedTarget(
  target: DeviceTargetClient,
  generation: DeviceGeneration,
): Promise<void> {
  const statements: LibsqlStatement[] = [
    {
      sql: `SELECT schema_version, cut_name, derived_at, source_watermark
        FROM device_sync_meta ORDER BY rowid`,
    },
    ...DEVICE_SOURCE_TABLES.map((table) => ({
      sql: `SELECT count(*) AS count FROM ${quoteDeviceDbIdentifier(table)}`,
    })),
    ...deviceDbClosureChecksSql().map((check) => ({ sql: check.sql })),
  ];
  const results = await target.batch(statements, "read");
  const metadata = results[0]?.rows;

  if (
    metadata?.length !== 1 ||
    Number(metadata[0]?.[0]) !== DEVICE_DB_SCHEMA_VERSION ||
    metadata[0]?.[1] !== "anchored" ||
    metadata[0]?.[2] !== generation.derivedAt ||
    metadata[0]?.[3] !== generation.fingerprint
  ) {
    throw new Error("Published target metadata does not identify the verified generation");
  }

  DEVICE_SOURCE_TABLES.forEach((table, index) => {
    const actual = Number(results[index + 1]?.rows[0]?.[0] ?? -1);

    if (actual !== generation.rowCounts[table]) {
      throw new Error(`Published target row count mismatch for ${table}: ${actual}`);
    }
  });

  results.slice(1 + DEVICE_SOURCE_TABLES.length).forEach((result, index) => {
    if (Number(result.rows[0]?.[0] ?? -1) !== 0) {
      throw new Error(`Published target reachability check ${index + 1} failed`);
    }
  });
}

async function clearStage(target: DeviceTargetClient): Promise<void> {
  await target.batch(
    [
      ...DEVICE_SOURCE_TABLES.map((table) => ({
        sql: `DELETE FROM ${quoteDeviceDbIdentifier(stageTable(table))}`,
      })),
      { sql: `DELETE FROM ${quoteDeviceDbIdentifier(STAGE_CHECKPOINT_TABLE)}` },
      { sql: `DELETE FROM ${quoteDeviceDbIdentifier(STAGE_CONTROL_TABLE)}` },
    ],
    "write",
  );
}

export async function publishDeviceGeneration(
  target: DeviceTargetClient,
  generation: DeviceGeneration,
  pageSize = DEFAULT_PAGE_SIZE,
  hooks: PublicationHooks = {},
): Promise<PublicationResult> {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || pageSize > MAX_PAGE_SIZE) {
    throw new Error(`Device stage page size must be between 1 and ${MAX_PAGE_SIZE}`);
  }

  await validateLiveTargetSchema(target);
  const stageSchemaRebuilt = await ensureStageSchema(target);
  const current = await readTargetMeta(target);

  if (current.sourceWatermark === generation.fingerprint) {
    await validatePublishedTarget(target, generation);
    let stageRetained = false;

    try {
      await clearStage(target);
    } catch (error) {
      stageRetained = true;
      log(
        `could not clear replayed stage: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return {
      backlogRows: 0,
      deltaRows: null,
      maxBufferedRows: 0,
      publishPath: "replay",
      published: true,
      replayed: true,
      restarted: false,
      rewriteReason: null,
      stageRebuilt: stageSchemaRebuilt,
      stageRetained,
      stagedRows: 0,
      writtenRows: 0,
    };
  }

  let rewriteReason: DeviceRewriteReason | null = stageSchemaRebuilt
    ? "schema_change"
    : isGenerationWatermark(current.sourceWatermark)
      ? null
      : "no_prior_generation";
  let delta: DeviceDelta | null = null;
  let scanBufferedRows = 0;

  if (rewriteReason === null) {
    const totalRows = DEVICE_SOURCE_TABLES.reduce(
      (total, table) => total + generation.rowCounts[table],
      0,
    );
    const scan = await computeDeviceDelta(
      target,
      generation,
      pageSize,
      deviceDeltaCeiling(totalRows),
    );
    scanBufferedRows = scan.kind === "delta" ? scan.delta.maxBufferedRows : scan.maxBufferedRows;

    if (scan.kind === "over-threshold") {
      rewriteReason = "delta_over_threshold";
    } else if (scan.delta.fingerprint !== generation.fingerprint) {
      rewriteReason = "delta_validation_mismatch";
      log("delta walk fingerprint disagreed with the derived generation; rewriting");
    } else {
      delta = scan.delta;
    }
  }

  if (delta) {
    await hooks.beforeCutover?.();
    const writtenRows = await applyDeviceDelta(target, generation, delta);
    await hooks.afterCutover?.();
    await validatePublishedTarget(target, generation);
    let deltaStageRetained = false;

    try {
      await clearStage(target);
    } catch (error) {
      deltaStageRetained = true;
      log(
        `could not clear the stage after a delta publish: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return {
      backlogRows: delta.rows,
      deltaRows: delta.rows,
      maxBufferedRows: scanBufferedRows,
      publishPath: "delta",
      published: true,
      replayed: false,
      restarted: false,
      rewriteReason: null,
      stageRebuilt: stageSchemaRebuilt,
      stageRetained: deltaStageRetained,
      stagedRows: 0,
      writtenRows,
    };
  }

  const stage = await stageAndVerify(target, generation, pageSize);
  const backlogRows = await measureBacklog(target, generation);
  await hooks.beforeCutover?.();
  const writtenRows = await cutoverDeviceGeneration(
    target,
    generation,
    hooks.cutoverFailureAfterStatement,
  );
  await hooks.afterCutover?.();
  await validatePublishedTarget(target, generation);
  let stageRetained = false;

  try {
    await clearStage(target);
  } catch (error) {
    stageRetained = true;
    log(
      `could not clear published stage: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    backlogRows,
    deltaRows: null,
    maxBufferedRows: Math.max(scanBufferedRows, stage.maxBufferedRows),
    publishPath: "rewrite",
    published: true,
    replayed: false,
    restarted: stage.restarted,
    rewriteReason,
    stageRebuilt: stageSchemaRebuilt || stage.rebuilt,
    stageRetained,
    stagedRows: stage.stagedRows,
    writtenRows,
  };
}

async function acquireLock(): Promise<null | (() => Promise<void>)> {
  const home = process.env.HOME ?? "/opt/data/home";
  const lockDir = process.env.DEVICE_MIRROR_LOCK_DIR ?? `${home}/.device-mirror.lock`;
  const staleMs = positiveIntegerEnv("DEVICE_MIRROR_LOCK_STALE_MS", DEFAULT_LOCK_STALE_MS);

  try {
    await mkdir(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }

    const lockStat = await stat(lockDir);

    if (Date.now() - lockStat.mtimeMs <= staleMs) {
      return null;
    }

    await rmdir(lockDir);
    await mkdir(lockDir);
  }

  const heartbeat = setInterval(() => {
    const now = new Date();
    utimes(lockDir, now, now).catch(() => {});
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();

  let released = false;
  const release = async () => {
    if (released) {
      return;
    }
    released = true;
    clearInterval(heartbeat);
    try {
      await rmdir(lockDir);
    } catch (error) {
      log(
        `could not release mirror lock: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.once(signal, () => {
      void release().finally(() => {
        process.exit(143);
      });
    });
  }

  return release;
}

type MirrorSummary = {
  artifactBytes: number | null;
  artifactVersion: number;
  checked: number | null;
  checkpoint: null | { generation: string; restarted: boolean; stagedRows: number };
  deltaRows: number | null;
  derivedAt: string | null;
  driftBacklogRows: number | null;
  driftAgeMs: number | null;
  error: string | null;
  errors: number;
  expected_interval_ms: number;
  gateState: "active" | "locked" | "paused";
  generation: string | null;
  localPeakDiskBytes: number | null;
  maxBufferedRows: number | null;
  ok: boolean;
  produced: number | null;
  publishPath: DevicePublishPath | null;
  queueDepth: number | null;
  rebuildCause: string | null;
  rewriteReason: DeviceRewriteReason | null;
  rebuildDurationMs: number | null;
  replicaFrame: number | null;
  replicaFramesSynced: number | null;
  replicaLagFrames: number | null;
  rowCounts: null | Record<DeviceSourceTable, number>;
  validation: "failed" | "locked" | "paused" | "verified";
};

function emptySummary(): MirrorSummary {
  return {
    artifactBytes: null,
    artifactVersion: DEVICE_DB_SCHEMA_VERSION,
    checked: 0,
    checkpoint: null,
    deltaRows: null,
    derivedAt: null,
    driftAgeMs: null,
    driftBacklogRows: null,
    error: null,
    errors: 0,
    expected_interval_ms: EXPECTED_INTERVAL_MS,
    gateState: "active",
    generation: null,
    localPeakDiskBytes: null,
    maxBufferedRows: null,
    ok: false,
    produced: 0,
    publishPath: null,
    queueDepth: null,
    rebuildCause: null,
    rebuildDurationMs: null,
    replicaFrame: null,
    replicaFramesSynced: null,
    replicaLagFrames: null,
    rewriteReason: null,
    rowCounts: null,
    validation: "failed",
  };
}

export async function main(): Promise<MirrorSummary> {
  const summary = emptySummary();
  let releaseLock: null | (() => Promise<void>) = null;

  try {
    releaseLock = await acquireLock();

    if (!releaseLock) {
      const locked = {
        ...summary,
        checked: null,
        gateState: "locked" as const,
        ok: true,
        produced: null,
        validation: "locked" as const,
      };
      console.log(JSON.stringify(locked));
      return locked;
    }

    const sourceUrl = requiredEnv("TURSO_DATABASE_URL");
    const sourceToken = requiredEnv("TURSO_AUTH_TOKEN");
    const targetUrl = requiredEnv("DEVICE_TURSO_DATABASE_URL");
    const targetToken = requiredEnv("DEVICE_TURSO_AUTH_TOKEN");

    if (sourceUrl.replace(/\/$/, "") === targetUrl.replace(/\/$/, "")) {
      throw new Error("Source and target database URLs must be different");
    }

    const target = new LibsqlHttpClient(targetUrl, targetToken);
    const publishIntervalMs = positiveIntegerEnv(
      "DEVICE_MIRROR_PUBLISH_INTERVAL_MS",
      DEFAULT_PUBLISH_INTERVAL_MS,
    );
    const previous = await readTargetMeta(target);
    const forced = process.env.DEVICE_MIRROR_FULL_REBUILD === "true";
    const previousTime = Date.parse(previous.derivedAt);
    const cadence = publishCadence(previous.derivedAt, Date.now(), publishIntervalMs, forced);
    if (!cadence.due) {
      const ageMs = cadence.ageMs;
      log(
        `live device replica is ${Math.round(ageMs / 60_000)}m old — next publish after ${Math.round(publishIntervalMs / 3_600_000)}h; nothing written`,
      );
      const paused = {
        ...summary,
        checked: null,
        derivedAt: previous.derivedAt,
        driftAgeMs: ageMs,
        gateState: "paused" as const,
        ok: true,
        produced: 0,
        validation: "paused" as const,
      };
      console.log(JSON.stringify(paused));
      return paused;
    }

    const home = process.env.HOME ?? "/opt/data/home";
    const stateDirectory = process.env.DEVICE_MIRROR_STATE_DIR ?? join(home, "device-mirror");
    const replicaPath = join(stateDirectory, "source-replica.db");
    const generationPath = join(stateDirectory, "device-generation.db");
    await mkdir(stateDirectory, { mode: 0o700, recursive: true });
    await chmod(stateDirectory, 0o700);

    const oldGenerationBytes = (await stat(generationPath).catch(() => undefined))?.size ?? 0;
    const sync = await syncSourceReplica({
      authToken: sourceToken,
      forceRebuild: process.env.DEVICE_MIRROR_FULL_REBUILD === "true",
      path: replicaPath,
      syncUrl: sourceUrl,
    });
    summary.replicaFrame = sync.frameNo;
    summary.replicaFramesSynced = sync.framesSynced;
    summary.replicaLagFrames = calculateReplicaLagFrames(sync);
    summary.rebuildCause = sync.rebuildCause;
    summary.rebuildDurationMs = sync.rebuildCause ? sync.durationMs : 0;

    const derivation = await runDeriver(replicaPath, generationPath);
    const generation = inspectDeviceGeneration(generationPath);
    const replicaBytes = (await stat(replicaPath)).size;
    summary.localPeakDiskBytes = replicaBytes + oldGenerationBytes + derivation.preVacuumBytes;
    summary.artifactBytes = generation.artifactBytes;
    summary.checked = DEVICE_SOURCE_TABLES.reduce(
      (total, table) => total + generation.rowCounts[table],
      0,
    );
    summary.derivedAt = generation.derivedAt;
    summary.generation = generation.fingerprint;
    summary.rowCounts = generation.rowCounts;
    summary.rebuildDurationMs = (summary.rebuildDurationMs ?? 0) + derivation.elapsedMs;

    const nextTime = Date.parse(generation.derivedAt);
    summary.driftAgeMs =
      Number.isFinite(previousTime) && Number.isFinite(nextTime)
        ? Math.max(0, nextTime - previousTime)
        : null;

    const pageSize = Math.min(
      positiveIntegerEnv("DEVICE_MIRROR_PAGE_SIZE", DEFAULT_PAGE_SIZE),
      MAX_PAGE_SIZE,
    );
    const publication = await publishDeviceGeneration(target, generation, pageSize);
    summary.checkpoint = {
      generation: generation.fingerprint,
      restarted: publication.restarted,
      stagedRows: publication.stagedRows,
    };
    summary.maxBufferedRows = publication.maxBufferedRows;
    summary.produced = publication.writtenRows;
    summary.publishPath = publication.publishPath;
    summary.rewriteReason = publication.rewriteReason;
    summary.deltaRows = publication.deltaRows;
    summary.driftBacklogRows = publication.backlogRows;
    summary.queueDepth = publication.published ? 0 : publication.backlogRows;
    summary.ok = true;
    summary.validation = "verified";
  } catch (error) {
    summary.errors = 1;
    summary.error = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    summary.ok = false;
    summary.validation = "failed";
    log(summary.error);
  } finally {
    await releaseLock?.();
  }

  console.log(JSON.stringify(summary));
  return summary;
}

if (import.meta.main) {
  const summary = await main();

  if (!summary.ok) {
    process.exit(1);
  }
}
