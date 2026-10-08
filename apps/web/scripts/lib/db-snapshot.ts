import { createClient, type InArgs, type ResultSet, type Value } from "@libsql/client";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { LOCAL_DB_CONCURRENCY } from "../../src/lib/database-concurrency";

import {
  DUMP_SCHEMA_SQL,
  isWithoutRowid,
  keysetPageSql,
  PRIMARY_KEY_COLUMNS_SQL,
  quoteIdent,
  type SchemaObject,
  type SequenceHead,
  sequenceHeadStatements,
  sqlLiteral,
  type SqlValue,
} from "../../src/lib/server/db-dump";

export const SNAPSHOT_PAGE_ROWS = 250;

const SNAPSHOT_FLUSH_BYTES = 1024 * 1024;

export type SnapshotClient = {
  execute: (statement: { args: InArgs; sql: string } | string) => Promise<ResultSet>;
};

export type SnapshotTableCount = { name: string; rows: number };

export type SnapshotReport = {
  bytes: number;
  elapsedMs: number;
  outPath: string;
  tables: SnapshotTableCount[];
  totalRows: number;
};

export type SnapshotOptions = {
  client: SnapshotClient;
  flushBytes?: number;
  header: string;
  ifMissing?: boolean;
  log?: (line: string) => void;
  now?: () => number;
  outPath: string;
  pageRows?: number;
};

export function devSnapshotPath(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");

  return join(dataHome, "fluncle", "seed.sql");
}

export function previousSnapshotPath(outPath: string): string {
  return outPath.endsWith(".sql")
    ? `${outPath.slice(0, -".sql".length)}.previous.sql`
    : `${outPath}.previous`;
}

export function partialSnapshotPath(outPath: string): string {
  return `${outPath}.partial`;
}

export function lockSnapshotPath(outPath: string): string {
  return `${outPath}.lock`;
}

const COMPLETE_MARKER = "-- Complete: ";
const LOCK_POLL_MS = 250;

export async function isCompleteSnapshot(outPath: string): Promise<boolean> {
  let handle;

  try {
    handle = await open(outPath, "r");
  } catch {
    return false;
  }

  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 256);
    const buffer = Buffer.alloc(length);

    await handle.read(buffer, 0, length, size - length);

    const lastLine = buffer.toString("utf8").trimEnd().split("\n").at(-1) ?? "";

    return lastLine.startsWith(COMPLETE_MARKER);
  } finally {
    await handle.close();
  }
}

async function acquireSnapshotLock(
  outPath: string,
  log: (line: string) => void,
): Promise<() => Promise<void>> {
  const lockPath = lockSnapshotPath(outPath);

  await mkdir(dirname(outPath), { recursive: true });

  const lock = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: `file:${lockPath}` });
  let announced = false;

  for (;;) {
    try {
      const held = await lock.transaction("write");

      return async () => {
        await held.rollback().catch(() => {});
        lock.close();
      };
    } catch (error) {
      if ((error as { code?: string }).code !== "SQLITE_BUSY") {
        lock.close();
        throw error;
      }
    }

    if (!announced) {
      log(`Another pull holds ${lockPath}; waiting for it to finish.`);
      announced = true;
    }

    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

function textCell(value: Value | undefined, what: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected text for ${what}, got ${typeof value}`);
  }

  return value;
}

async function keyColumnsFor(client: SnapshotClient, object: SchemaObject): Promise<string[]> {
  if (!isWithoutRowid(object)) {
    return ["rowid"];
  }

  const result = await client.execute({
    args: [object.name],
    sql: PRIMARY_KEY_COLUMNS_SQL,
  });
  const keys = result.rows.map((row) => textCell(row[0], "a primary key column name"));

  if (keys.length === 0) {
    throw new Error(`WITHOUT ROWID table "${object.name}" reports no primary key columns`);
  }

  return keys;
}

async function readSequenceHeads(
  client: SnapshotClient,
  schema: readonly SchemaObject[],
): Promise<SequenceHead[]> {
  const present = await client.execute(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
  );

  if (present.rows.length === 0) {
    return [];
  }

  const dumped = new Set(
    schema.filter((object) => object.type === "table").map((object) => object.name),
  );
  const result = await client.execute("SELECT name, seq FROM sqlite_sequence ORDER BY name");

  return result.rows
    .map((row) => ({
      name: textCell(row[0], "a sequence name"),
      seq: (row[1] ?? null) as SqlValue,
    }))
    .filter((head) => dumped.has(head.name));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);

    return true;
  } catch {
    return false;
  }
}

export async function pullSnapshot(
  options: SnapshotOptions & { ifMissing: true },
): Promise<SnapshotReport | null>;
export async function pullSnapshot(options: SnapshotOptions): Promise<SnapshotReport>;
export async function pullSnapshot(options: SnapshotOptions): Promise<SnapshotReport | null> {
  const log = options.log ?? (() => {});
  const release = await acquireSnapshotLock(options.outPath, log);

  try {
    if (options.ifMissing && (await isCompleteSnapshot(options.outPath))) {
      log(`A complete snapshot already exists at ${options.outPath}; nothing to pull.`);

      return null;
    }

    return await pullSnapshotLocked(options);
  } finally {
    await release();
  }
}

async function pullSnapshotLocked(options: SnapshotOptions): Promise<SnapshotReport> {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const pageRows = Math.max(1, Math.floor(options.pageRows ?? SNAPSHOT_PAGE_ROWS));
  const flushBytes = Math.max(1, options.flushBytes ?? SNAPSHOT_FLUSH_BYTES);
  const startedAt = now();
  const { client, outPath } = options;
  const partialPath = partialSnapshotPath(outPath);
  const previousPath = previousSnapshotPath(outPath);

  await mkdir(dirname(outPath), { recursive: true });
  await rm(partialPath, { force: true });

  let movedPrevious = false;

  if (await fileExists(outPath)) {
    await rename(outPath, previousPath);
    movedPrevious = true;
    log(`Moved the previous snapshot aside to ${previousPath}; it is not a fresh backup.`);
  }

  const handle = await open(partialPath, "w");
  let bytes = 0;
  let pending: string[] = [];
  let pendingBytes = 0;

  const flush = async (): Promise<void> => {
    if (pending.length === 0) {
      return;
    }

    const chunk = pending.join("");

    pending = [];
    pendingBytes = 0;
    await handle.write(chunk);
  };

  const emit = async (line: string): Promise<void> => {
    const text = `${line}\n`;
    const size = Buffer.byteLength(text, "utf8");

    bytes += size;
    pending.push(text);
    pendingBytes += size;

    if (pendingBytes >= flushBytes) {
      await flush();
    }
  };

  const tables: SnapshotTableCount[] = [];

  try {
    const schemaResult = await client.execute(DUMP_SCHEMA_SQL);
    const schema: SchemaObject[] = schemaResult.rows.map((row) => ({
      name: textCell(row[1], "a schema object name"),
      sql: textCell(row[2], "a schema object definition"),
      type: textCell(row[0], "a schema object type"),
    }));

    await emit(options.header);
    await emit(`-- Started ${new Date(startedAt).toISOString()}.`);
    await emit("PRAGMA foreign_keys=OFF;");
    await emit("BEGIN TRANSACTION;");

    for (const object of schema) {
      if (object.type === "table") {
        await emit(`${object.sql};`);
      }
    }

    for (const object of schema) {
      if (object.type !== "table") {
        continue;
      }

      const keys = await keyColumnsFor(client, object);
      const target = quoteIdent(object.name);
      let cursor: Value[] | null = null;
      let rowCount = 0;

      for (;;) {
        const page: ResultSet = await client.execute({
          args: [...(cursor ?? []), pageRows],
          sql: keysetPageSql(object.name, keys, cursor !== null),
        });
        const columnList = page.columns.slice(keys.length).map(quoteIdent).join(", ");

        for (const row of page.rows) {
          const values: string[] = [];

          for (let index = keys.length; index < page.columns.length; index += 1) {
            values.push(sqlLiteral(row[index] as SqlValue));
          }

          await emit(`INSERT INTO ${target} (${columnList}) VALUES (${values.join(", ")});`);
        }

        rowCount += page.rows.length;

        const last = page.rows.at(-1);

        if (page.rows.length < pageRows || !last) {
          break;
        }

        cursor = keys.map((_, index) => last[index] ?? null);
      }

      tables.push({ name: object.name, rows: rowCount });
      log(`  ${object.name}: ${rowCount} rows`);
    }

    for (const sequence of await readSequenceHeads(client, schema)) {
      for (const statement of sequenceHeadStatements(sequence)) {
        await emit(statement);
      }
    }

    for (const object of schema) {
      if (object.type !== "table") {
        await emit(`${object.sql};`);
      }
    }

    const totalRows = tables.reduce((sum, table) => sum + table.rows, 0);

    await emit("COMMIT;");
    await emit(`-- Complete: ${tables.length} tables, ${totalRows} rows.`);
    await flush();
    await handle.sync();
    await handle.close();
    await rename(partialPath, outPath);

    await rm(previousPath, { force: true });

    return {
      bytes,
      elapsedMs: now() - startedAt,
      outPath,
      tables,
      totalRows,
    };
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(partialPath, { force: true });

    const kept =
      movedPrevious || (await fileExists(previousPath))
        ? ` The previous snapshot stays at ${previousPath}, named so it cannot pass for a fresh one.`
        : "";

    throw new Error(
      `Snapshot failed; no ${outPath} was written.${kept} Cause: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

export function formatSnapshotReport(report: SnapshotReport): string {
  const width = Math.max(5, ...report.tables.map((table) => table.name.length));
  const lines = report.tables.map(
    (table) => `  ${table.name.padEnd(width)}  ${String(table.rows).padStart(10)}`,
  );
  const megabytes = (report.bytes / (1024 * 1024)).toFixed(1);
  const seconds = (report.elapsedMs / 1000).toFixed(1);

  return [
    `Wrote ${report.outPath}`,
    ...lines,
    `  ${"total".padEnd(width)}  ${String(report.totalRows).padStart(10)}`,
    `${report.tables.length} tables, ${report.totalRows} rows, ${report.bytes} bytes (${megabytes} MiB) in ${seconds}s.`,
  ].join("\n");
}
