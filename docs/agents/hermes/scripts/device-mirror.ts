#!/usr/bin/env bun
// device-mirror.ts — the hourly, in-place mirror for the shared read-only mobile catalogue DB.
//
// The source is production Turso through a READ-ONLY token. The target is the dedicated device
// replica through a WRITE token. Devices connect to the target directly, so every source query is
// generated from DEVICE_DB_COLUMNS — the column allowlist is a security boundary, not a convenience.
//
// A tick reads one consistent anchored-cut snapshot from the source, diffs every whitelisted tuple
// against the target, then applies dependent-first deletes followed by parameterized parent-first
// upserts. It never drops or recreates a data table. device_sync_meta is updated LAST; a crash
// before that point leaves an old watermark but no ambiguity, because the next tick re-diffs the
// complete row sets.
//
// stdout: one JSON ledger summary line. Diagnostics go to stderr.

import { createHash } from "node:crypto";
import { mkdir, rmdir, stat } from "node:fs/promises";

import { REC_ELIGIBLE_WHERE } from "./catalogue-eligibility";
import {
  DEVICE_DB_COLUMNS,
  DEVICE_DB_PRIMARY_KEYS,
  DEVICE_DB_SCHEMA_VERSION,
  DEVICE_SOURCE_TABLES,
  type DeviceSourceTable,
  quoteDeviceDbIdentifier,
  selectDeviceRowsSql,
} from "./device-db-derivation";

export type DeviceSqlValue = ArrayBuffer | ArrayBufferView | bigint | number | string | null;

export type DeviceRow = Record<string, DeviceSqlValue>;
export type DeviceRowSets = Record<DeviceSourceTable, DeviceRow[]>;

export type TableDiff = {
  changedRows: DeviceRow[];
  deletedRows: DeviceRow[];
  newRows: DeviceRow[];
  unchangedRows: DeviceRow[];
};

export type MirrorOperation =
  | { kind: "delete"; row: DeviceRow; table: DeviceSourceTable }
  | { kind: "upsert"; row: DeviceRow; table: DeviceSourceTable };

export type MirrorPlan = {
  operations: MirrorOperation[];
  tables: Record<DeviceSourceTable, TableDiff>;
};

export type LibsqlStatement = {
  args?: readonly DeviceSqlValue[];
  sql: string;
};

type QueryResult = {
  affectedRows: number;
  columns: string[];
  rows: DeviceSqlValue[][];
};

type MirrorSummaryState = {
  checked: number | null;
  derivedAt: null | string;
  driftMeasured: boolean;
  error: null | string;
  errors: number;
  expected_interval_ms: number;
  gateState: "active" | "locked";
  produced: number | null;
  queueDepth: number | null;
  sourceWatermark: null | string;
  tables: null | Record<
    DeviceSourceTable,
    { changed: number; deleted: number; new: number; unchanged: number }
  >;
};

type MirrorSummary = MirrorSummaryState & { ok: boolean };

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
const DEFAULT_BATCH_SIZE = 250;
const DEFAULT_LOCK_STALE_MS = 2 * EXPECTED_INTERVAL_MS;

/** Parent rows and tracks land before rows that refer to them. */
export const DEVICE_MIRROR_UPSERT_ORDER = [
  "albums",
  "artists",
  "labels",
  "tracks",
  "findings",
  "track_artists",
] as const satisfies readonly DeviceSourceTable[];

/**
 * Dependent rows leave first, the reverse side of the relationship order. Deletes run before
 * upserts so a departed entity cannot hold a UNIQUE slug or Log ID needed by its replacement.
 */
export const DEVICE_MIRROR_DELETE_ORDER = [
  "track_artists",
  "findings",
  "tracks",
  "artists",
  "labels",
  "albums",
] as const satisfies readonly DeviceSourceTable[];

const log = (message: string) => console.error(`[device-mirror] ${message}`);

function emptyRowSets(): DeviceRowSets {
  return {
    albums: [],
    artists: [],
    findings: [],
    labels: [],
    track_artists: [],
    tracks: [],
  };
}

function bytesOf(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function encodedValue(value: DeviceSqlValue): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "bigint") {
    return `integer:${value}`;
  }
  if (typeof value === "number") {
    return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
  }
  if (typeof value === "string") {
    return `text:${value.length}:${value}`;
  }

  return `blob:${Buffer.from(bytesOf(value)).toString("base64")}`;
}

function valuesEqual(left: DeviceSqlValue, right: DeviceSqlValue): boolean {
  if (
    (left instanceof ArrayBuffer || ArrayBuffer.isView(left)) &&
    (right instanceof ArrayBuffer || ArrayBuffer.isView(right))
  ) {
    const leftBytes = bytesOf(left);
    const rightBytes = bytesOf(right);

    return (
      leftBytes.byteLength === rightBytes.byteLength &&
      leftBytes.every((byte, index) => byte === rightBytes[index])
    );
  }

  return Object.is(left, right);
}

function rowKey(table: DeviceSourceTable, row: DeviceRow): string {
  return DEVICE_DB_PRIMARY_KEYS[table]
    .map((column) => `${column}=${encodedValue(row[column] ?? null)}`)
    .join("|");
}

function rowsEqual(table: DeviceSourceTable, left: DeviceRow, right: DeviceRow): boolean {
  return DEVICE_DB_COLUMNS[table].every((column) =>
    valuesEqual(left[column] ?? null, right[column] ?? null),
  );
}

function keyedRows(table: DeviceSourceTable, rows: readonly DeviceRow[]): Map<string, DeviceRow> {
  const keyed = new Map<string, DeviceRow>();

  for (const row of rows) {
    const key = rowKey(table, row);

    if (keyed.has(key)) {
      throw new Error(`Duplicate ${table} primary key in mirror snapshot: ${key}`);
    }

    keyed.set(key, row);
  }

  return keyed;
}

function byKey(table: DeviceSourceTable) {
  return (left: DeviceRow, right: DeviceRow): number =>
    rowKey(table, left).localeCompare(rowKey(table, right));
}

/**
 * Pure mirror planner. A source-only key is new; a shared key with any changed whitelisted tuple
 * is changed; an identical shared tuple is unchanged; and a target-only key is deleted.
 */
export function planDeviceMirrorDiff(source: DeviceRowSets, target: DeviceRowSets): MirrorPlan {
  const tables = {} as Record<DeviceSourceTable, TableDiff>;

  for (const table of DEVICE_SOURCE_TABLES) {
    const sourceRows = keyedRows(table, source[table]);
    const targetRows = keyedRows(table, target[table]);
    const tableDiff: TableDiff = {
      changedRows: [],
      deletedRows: [],
      newRows: [],
      unchangedRows: [],
    };

    for (const [key, sourceRow] of sourceRows) {
      const targetRow = targetRows.get(key);

      if (!targetRow) {
        tableDiff.newRows.push(sourceRow);
      } else if (rowsEqual(table, sourceRow, targetRow)) {
        tableDiff.unchangedRows.push(sourceRow);
      } else {
        tableDiff.changedRows.push(sourceRow);
      }
    }

    for (const [key, targetRow] of targetRows) {
      if (!sourceRows.has(key)) {
        tableDiff.deletedRows.push(targetRow);
      }
    }

    tableDiff.newRows.sort(byKey(table));
    tableDiff.changedRows.sort(byKey(table));
    tableDiff.deletedRows.sort(byKey(table));
    tableDiff.unchangedRows.sort(byKey(table));
    tables[table] = tableDiff;
  }

  const operations: MirrorOperation[] = [];

  for (const table of DEVICE_MIRROR_DELETE_ORDER) {
    operations.push(
      ...tables[table].deletedRows.map((row) => ({ kind: "delete" as const, row, table })),
    );
  }

  for (const table of DEVICE_MIRROR_UPSERT_ORDER) {
    const upserts = [...tables[table].newRows, ...tables[table].changedRows].sort(byKey(table));

    operations.push(...upserts.map((row) => ({ kind: "upsert" as const, row, table })));
  }

  return { operations, tables };
}

export function buildMirrorStatement(operation: MirrorOperation): LibsqlStatement {
  const columns = DEVICE_DB_COLUMNS[operation.table];
  const keys = DEVICE_DB_PRIMARY_KEYS[operation.table];

  if (operation.kind === "delete") {
    return {
      args: keys.map((column) => operation.row[column] ?? null),
      sql: `DELETE FROM ${quoteDeviceDbIdentifier(operation.table)}
        WHERE ${keys.map((column) => `${quoteDeviceDbIdentifier(column)} = ?`).join(" AND ")}`,
    };
  }

  const mutableColumns = columns.filter((column) => !keys.includes(column));
  const conflict = keys.map(quoteDeviceDbIdentifier).join(", ");
  const update =
    mutableColumns.length === 0
      ? "DO NOTHING"
      : `DO UPDATE SET ${mutableColumns
          .map(
            (column) =>
              `${quoteDeviceDbIdentifier(column)} = excluded.${quoteDeviceDbIdentifier(column)}`,
          )
          .join(", ")}`;

  return {
    args: columns.map((column) => operation.row[column] ?? null),
    sql: `INSERT INTO ${quoteDeviceDbIdentifier(operation.table)}
      (${columns.map(quoteDeviceDbIdentifier).join(", ")})
      VALUES (${columns.map(() => "?").join(", ")})
      ON CONFLICT (${conflict}) ${update}`,
  };
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

/**
 * Dependency-free Hrana HTTP client. The box image intentionally carries no workspace
 * node_modules; this is the same `/v2/pipeline` transport shape used by backup-sweep.ts.
 */
export class LibsqlHttpClient {
  readonly #authToken: string;
  readonly #baseUrl: string;
  readonly #name: "source" | "target";

  constructor(name: "source" | "target", url: string, authToken: string) {
    this.#name = name;
    this.#baseUrl = url.replace(/^libsql:\/\//, "https://").replace(/\/$/, "");
    this.#authToken = authToken;

    if (!/^https?:\/\//.test(this.#baseUrl)) {
      throw new Error(`${name} database URL must use libsql://, https://, or http://`);
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
      throw new Error(`libSQL ${this.#name} pipeline returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
      results?: Array<{
        error?: { code?: string; message?: string };
        response?: {
          result?: {
            step_errors?: Array<{ code?: string; message?: string } | null>;
            step_results?: Array<WireStatementResult | null>;
          };
          type?: string;
        };
        type?: string;
      }>;
    };
    const batchResult = payload.results?.[0];

    if (batchResult?.type === "error") {
      throw new Error(
        `libSQL ${this.#name} pipeline failed: ${batchResult.error?.code ?? "unknown"}`,
      );
    }
    if (batchResult?.response?.type !== "batch" || !batchResult.response.result) {
      throw new Error(`libSQL ${this.#name} pipeline returned no batch result`);
    }

    const stepErrors = batchResult.response.result.step_errors ?? [];
    const failedStep = stepErrors.findIndex((error) => error !== null);

    if (failedStep >= 0) {
      const failure = stepErrors[failedStep];
      throw new Error(
        `libSQL ${this.#name} batch step ${failedStep} failed: ${failure?.code ?? "unknown"}`,
      );
    }

    const stepResults = batchResult.response.result.step_results ?? [];

    if (!stepResults[0] || !stepResults[commitStep]) {
      throw new Error(`libSQL ${this.#name} transaction did not commit`);
    }

    return statements.map((_, index) => {
      const result = stepResults[index + 1];

      if (!result) {
        throw new Error(`libSQL ${this.#name} batch step ${index + 1} did not execute`);
      }

      return {
        affectedRows: result.affected_row_count ?? 0,
        columns: (result.cols ?? []).map((column) => column.name ?? ""),
        rows: (result.rows ?? []).map((row) => row.map(decodeCell)),
      };
    });
  }
}

function targetTableSql(table: DeviceSourceTable): string {
  const columns = DEVICE_DB_COLUMNS[table].map(quoteDeviceDbIdentifier).join(", ");
  const order = DEVICE_DB_PRIMARY_KEYS[table].map(quoteDeviceDbIdentifier).join(", ");

  return `SELECT ${columns}
    FROM ${quoteDeviceDbIdentifier(table)}
    ORDER BY ${order}`;
}

function rowsFromResult(table: DeviceSourceTable, result: QueryResult): DeviceRow[] {
  const expectedColumns = [...DEVICE_DB_COLUMNS[table]];

  if (
    result.columns.length !== expectedColumns.length ||
    result.columns.some((column, index) => column !== expectedColumns[index])
  ) {
    throw new Error(`Unexpected ${table} projection from libSQL`);
  }

  return result.rows.map((cells) => {
    if (cells.length !== expectedColumns.length) {
      throw new Error(`Unexpected ${table} row width from libSQL`);
    }

    return Object.fromEntries(
      expectedColumns.map((column, index) => [column, cells[index] ?? null]),
    ) as DeviceRow;
  });
}

async function readDeviceRows(
  client: LibsqlHttpClient,
  side: "source" | "target",
): Promise<DeviceRowSets> {
  const statements = DEVICE_SOURCE_TABLES.map((table) => ({
    sql:
      side === "source"
        ? selectDeviceRowsSql(table, "anchored", REC_ELIGIBLE_WHERE, "main")
        : targetTableSql(table),
  }));
  const results = await client.batch(statements, "read");
  const rows = emptyRowSets();

  DEVICE_SOURCE_TABLES.forEach((table, index) => {
    const result = results[index];

    if (!result) {
      throw new Error(`Missing ${side} result for ${table}`);
    }

    rows[table] = rowsFromResult(table, result);
  });

  return rows;
}

function contentFingerprint(rows: DeviceRowSets): string {
  const hash = createHash("sha256");
  hash.update(`device-db-schema:${DEVICE_DB_SCHEMA_VERSION}\ncut:anchored\n`);

  for (const table of DEVICE_SOURCE_TABLES) {
    hash.update(`table:${table}\ncolumns:${DEVICE_DB_COLUMNS[table].join(",")}\n`);

    for (const row of rows[table]) {
      for (const column of DEVICE_DB_COLUMNS[table]) {
        hash.update(`${column}=${encodedValue(row[column] ?? null)}\n`);
      }
    }
  }

  return `sha256:${hash.digest("hex")}`;
}

async function assertTargetMeta(target: LibsqlHttpClient): Promise<void> {
  const [result] = await target.batch(
    [
      {
        sql: `SELECT schema_version, cut_name, derived_at, source_watermark
          FROM device_sync_meta
          ORDER BY rowid`,
      },
    ],
    "read",
  );

  if (!result || result.rows.length !== 1) {
    throw new Error("Target device_sync_meta must contain exactly one row");
  }

  const row = result.rows[0];
  const schemaVersion = Number(row?.[0]);
  const cutName = row?.[1];

  if (schemaVersion !== DEVICE_DB_SCHEMA_VERSION) {
    throw new Error(
      `Target device schema version ${schemaVersion} differs from code version ${DEVICE_DB_SCHEMA_VERSION}; operator migration required`,
    );
  }
  if (typeof cutName !== "string") {
    throw new Error("Target device cut name is not text");
  }
  if (cutName !== "anchored") {
    throw new Error(`Target device cut is ${cutName || "(empty)"}, expected anchored`);
  }
}

async function updateTargetMeta(
  target: LibsqlHttpClient,
  derivedAt: string,
  sourceWatermark: string,
): Promise<void> {
  const [result] = await target.batch(
    [
      {
        args: ["anchored", derivedAt, sourceWatermark, DEVICE_DB_SCHEMA_VERSION],
        sql: `UPDATE device_sync_meta
          SET cut_name = ?, derived_at = ?, source_watermark = ?
          WHERE schema_version = ?`,
      },
    ],
    "write",
  );

  if (result?.affectedRows !== 1) {
    throw new Error("Target device_sync_meta update did not affect exactly one row");
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

function tableSummary(plan: MirrorPlan): NonNullable<MirrorSummaryState["tables"]> {
  return Object.fromEntries(
    DEVICE_SOURCE_TABLES.map((table) => [
      table,
      {
        changed: plan.tables[table].changedRows.length,
        deleted: plan.tables[table].deletedRows.length,
        new: plan.tables[table].newRows.length,
        unchanged: plan.tables[table].unchangedRows.length,
      },
    ]),
  ) as NonNullable<MirrorSummaryState["tables"]>;
}

function finalSummary(state: MirrorSummaryState): MirrorSummary {
  return { ...state, ok: state.errors === 0 };
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

  return async () => {
    try {
      await rmdir(lockDir);
    } catch (error) {
      log(
        `could not release mirror lock: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
}

export async function main(): Promise<MirrorSummary> {
  const state: MirrorSummaryState = {
    checked: 0,
    derivedAt: null,
    driftMeasured: false,
    error: null,
    errors: 0,
    expected_interval_ms: EXPECTED_INTERVAL_MS,
    gateState: "active",
    produced: 0,
    queueDepth: null,
    sourceWatermark: null,
    tables: null,
  };
  let releaseLock: null | (() => Promise<void>) = null;
  let sourceRows: DeviceRowSets | undefined;
  let target: LibsqlHttpClient | undefined;

  try {
    releaseLock = await acquireLock();

    if (!releaseLock) {
      const locked = finalSummary({
        ...state,
        checked: null,
        gateState: "locked",
        produced: null,
        queueDepth: null,
      });
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

    const source = new LibsqlHttpClient("source", sourceUrl, sourceToken);
    target = new LibsqlHttpClient("target", targetUrl, targetToken);

    await assertTargetMeta(target);

    sourceRows = await readDeviceRows(source, "source");
    const targetRows = await readDeviceRows(target, "target");
    const plan = planDeviceMirrorDiff(sourceRows, targetRows);

    state.checked = DEVICE_SOURCE_TABLES.reduce(
      (total, table) => total + sourceRows[table].length,
      0,
    );
    state.driftMeasured = true;
    state.queueDepth = plan.operations.length;
    const sourceWatermark = contentFingerprint(sourceRows);
    state.sourceWatermark = sourceWatermark;
    state.tables = tableSummary(plan);

    const batchSize = Math.min(
      positiveIntegerEnv("DEVICE_MIRROR_WRITE_BATCH", DEFAULT_BATCH_SIZE),
      500,
    );

    for (let offset = 0; offset < plan.operations.length; offset += batchSize) {
      const operations = plan.operations.slice(offset, offset + batchSize);
      await target.batch(operations.map(buildMirrorStatement), "write");
      state.produced = (state.produced ?? 0) + operations.length;
      state.queueDepth = plan.operations.length - (state.produced ?? 0);
    }

    const verifiedTargetRows = await readDeviceRows(target, "target");
    const remaining = planDeviceMirrorDiff(sourceRows, verifiedTargetRows);
    state.queueDepth = remaining.operations.length;

    if (remaining.operations.length !== 0) {
      throw new Error(`Target still has ${remaining.operations.length} drift row(s) after writes`);
    }

    state.derivedAt = new Date().toISOString();
    await updateTargetMeta(target, state.derivedAt, sourceWatermark);
  } catch (error) {
    state.errors += 1;
    state.error = error instanceof Error ? error.message : String(error);

    if (sourceRows && target) {
      try {
        const currentTargetRows = await readDeviceRows(target, "target");
        state.queueDepth = planDeviceMirrorDiff(sourceRows, currentTargetRows).operations.length;
        state.driftMeasured = true;
      } catch (measurementError) {
        log(
          `could not re-measure remaining drift: ${
            measurementError instanceof Error ? measurementError.message : String(measurementError)
          }`,
        );
      }
    }

    log(state.error);
  } finally {
    await releaseLock?.();
  }

  const summary = finalSummary(state);
  console.log(JSON.stringify(summary));
  return summary;
}

if (import.meta.main) {
  const summary = await main();

  if (summary.errors !== 0) {
    process.exit(1);
  }
}
