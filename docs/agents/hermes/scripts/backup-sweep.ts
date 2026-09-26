#!/usr/bin/env bun

import { createWriteStream, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { join } from "node:path";
import { pipeline as streamPipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { createGzip } from "node:zlib";
import { rm } from "node:fs/promises";

import {
  boxStateCandidates,
  buildBoxStateArchive,
  type BoxStateManifest,
  boxStateKeyFromEnv,
  selectBoxStatePaths,
} from "./box-state-snapshot";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);

  return index >= 0 ? process.argv[index + 1] : undefined;
}

const OUT_DIR = argValue("--out");
const BOX_STATE_OUT_DIR = argValue("--box-state-out");
const DRY_RUN = OUT_DIR !== undefined || BOX_STATE_OUT_DIR !== undefined;

const TURSO_URL = process.env.TURSO_DATABASE_URL ?? "";
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN ?? "";

export type BackupR2Config = {
  accessKeyId: string;
  accountId: string;
  bucket: string;

  bucketUrl: string;
  secretAccessKey: string;
};

export function backupR2Config(env: NodeJS.ProcessEnv = process.env): BackupR2Config {
  const accountId = env.R2_ACCOUNT_ID ?? "";
  const bucket = env.FLUNCLE_BACKUP_R2_BUCKET ?? "fluncle-backups";

  return {
    accessKeyId: env.FLUNCLE_BACKUP_R2_ACCESS_KEY_ID ?? "",
    accountId,
    bucket,
    bucketUrl: `https://${accountId}.r2.cloudflarestorage.com/${bucket}`,
    secretAccessKey: env.FLUNCLE_BACKUP_R2_SECRET_ACCESS_KEY ?? "",
  };
}

const R2 = backupR2Config();

const KEEP_DAILY = Number(process.env.FLUNCLE_BACKUP_KEEP_DAILY ?? "30");
const KEEP_MONTHLY = Number(process.env.FLUNCLE_BACKUP_KEEP_MONTHLY ?? "12");

const BOXSTATE_KEEP_DAILY = Number(process.env.FLUNCLE_BOXSTATE_KEEP_DAILY ?? "14");
const BOXSTATE_KEEP_MONTHLY = Number(process.env.FLUNCLE_BOXSTATE_KEEP_MONTHLY ?? "6");

const ROW_BATCH = Math.max(1, Number(process.env.FLUNCLE_BACKUP_ROW_BATCH ?? "1000"));

const WRITE_CHUNK_BYTES = 512 * 1024;

const PREFIX = "db-backups/";
const DAILY_PREFIX = `${PREFIX}daily/`;
const MONTHLY_PREFIX = `${PREFIX}monthly/`;

export const BOXSTATE_PREFIX = "box-state/";
export const BOXSTATE_DAILY_PREFIX = `${BOXSTATE_PREFIX}daily/`;
export const BOXSTATE_MONTHLY_PREFIX = `${BOXSTATE_PREFIX}monthly/`;

export const BOXSTATE_ARTIFACT_NAME = "box-state.tar.gz.enc";

export const MANIFEST_NAME = "manifest.json";

const log = (message: string) => console.error(`[backup-sweep] ${message}`);

type SqlValue = ArrayBuffer | ArrayBufferView | bigint | boolean | number | string | null;
type SchemaObject = { name: string; sql: string; type: string };

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function sqlLiteral(value: SqlValue): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    let hex = "";
    for (const byte of bytes) {
      hex += byte.toString(16).padStart(2, "0");
    }
    return `X'${hex}'`;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

export function chooseAnchor(
  candidates: readonly { firstColumn: string; name: string; rowCount: number }[],
): { column: string; table: string } | null {
  const eligible = candidates.filter((c) => c.rowCount > 0 && c.firstColumn !== "");
  if (eligible.length === 0) {
    return null;
  }
  const tracks = eligible.find((c) => c.name === "tracks");
  const chosen =
    tracks ??
    [...eligible].sort((a, b) => b.rowCount - a.rowCount || a.name.localeCompare(b.name))[0];
  return chosen ? { column: chosen.firstColumn, table: chosen.name } : null;
}

function spotCell(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    let hex = "";
    for (const byte of bytes) {
      hex += byte.toString(16).padStart(2, "0");
    }
    return hex;
  }
  return JSON.stringify(value);
}

export function selectExpiredBackupKeys(
  keys: readonly string[],
  options: { dailyPrefix: string; keepDaily: number; keepMonthly: number; monthlyPrefix: string },
): string[] {
  const groupByFolder = (prefix: string, segment: RegExp): Map<string, string[]> => {
    const groups = new Map<string, string[]>();
    for (const key of keys) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const folder = key.slice(prefix.length).split("/")[0] ?? "";
      if (!segment.test(folder)) {
        continue;
      }
      const bucket = groups.get(folder) ?? [];
      bucket.push(key);
      groups.set(folder, bucket);
    }
    return groups;
  };
  const expired: string[] = [];
  const prune = (groups: Map<string, string[]>, keep: number): void => {
    const folders = [...groups.keys()].sort((a, b) => b.localeCompare(a));
    for (const folder of folders.slice(Math.max(0, keep))) {
      expired.push(...(groups.get(folder) ?? []));
    }
  };
  prune(groupByFolder(options.dailyPrefix, /^\d{4}-\d{2}-\d{2}$/), options.keepDaily);
  prune(groupByFolder(options.monthlyPrefix, /^\d{4}-\d{2}$/), options.keepMonthly);
  return expired.sort();
}

const encoder = new TextEncoder();

function webCryptoBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}
function toHex(buffer: ArrayBuffer): string {
  let hex = "";
  for (const byte of new Uint8Array(buffer)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = webCryptoBytes(typeof data === "string" ? encoder.encode(data) : data);
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}
async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key instanceof ArrayBuffer ? key : webCryptoBytes(key),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
function canonicalUri(pathname: string): string {
  return pathname.split("/").map(encodeRfc3986).join("/");
}
function canonicalQuery(url: URL): string {
  const pairs = [...url.searchParams.entries()].map(
    ([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const,
  );
  pairs.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
  );
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}
function amzDate(now: Date): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}
export async function signS3Request(options: {
  accessKeyId: string;
  body?: Uint8Array;
  contentType?: string;
  method: string;
  now: Date;

  payloadHashSha256?: string;
  region: string;
  secretAccessKey: string;
  service: string;
  url: string;
}): Promise<Record<string, string>> {
  const url = new URL(options.url);
  const stamp = amzDate(options.now);
  const dateStamp = stamp.slice(0, 8);
  const payloadHash =
    options.payloadHashSha256 ?? (await sha256Hex(options.body ?? new Uint8Array()));
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": stamp,
  };
  if (options.contentType) {
    headers["content-type"] = options.contentType;
  }
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    options.method,
    canonicalUri(url.pathname),
    canonicalQuery(url),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${options.region}/${options.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, await sha256Hex(canonicalRequest)].join(
    "\n",
  );
  let signingKey: ArrayBuffer | Uint8Array = encoder.encode(`AWS4${options.secretAccessKey}`);
  for (const part of [dateStamp, options.region, options.service, "aws4_request"]) {
    signingKey = await hmac(signingKey, part);
  }
  const signature = toHex(await hmac(signingKey, stringToSign));
  const { host: _host, ...sent } = headers;
  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

type HranaCell = { base64?: string; type: string; value?: unknown };

function decodeCell(cell: HranaCell): SqlValue {
  switch (cell.type) {
    case "null":
      return null;
    case "integer":
      return BigInt(String(cell.value));
    case "float":
      return typeof cell.value === "number" ? cell.value : Number(cell.value);
    case "blob":
      return new Uint8Array(Buffer.from(cell.base64 ?? "", "base64"));
    default:
      return cell.value == null ? "" : String(cell.value as number | string);
  }
}

type HranaResult = { cols: { name: string }[]; rows: HranaCell[][] };

async function pipeline(sqls: string[]): Promise<HranaResult[]> {
  const base = TURSO_URL.replace(/^libsql:\/\//, "https://").replace(/\/$/, "");
  const res = await fetch(`${base}/v2/pipeline`, {
    body: JSON.stringify({
      requests: [
        ...sqls.map((sql) => ({ stmt: { sql }, type: "execute" as const })),
        { type: "close" as const },
      ],
    }),
    headers: {
      "Content-Type": "application/json",
      ...(TURSO_TOKEN && TURSO_TOKEN !== "local-dev"
        ? { Authorization: `Bearer ${TURSO_TOKEN}` }
        : {}),
    },
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`libSQL pipeline ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    results: { error?: { message?: string }; response?: { result?: HranaResult }; type: string }[];
  };
  return data.results
    .filter((r) => r.type === "ok" && r.response?.result)
    .map((r) => {
      if (r.type === "error") {
        throw new Error(`libSQL statement error: ${r.error?.message ?? "unknown"}`);
      }
      return r.response?.result as HranaResult;
    });
}

export function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export async function signedPut(
  url: string,
  options: {
    accessKeyId: string;
    body: Uint8Array | { bytes: number; path: string; sha256: string };
    contentType: string;
    now?: Date;
    secretAccessKey: string;
  },
): Promise<void> {
  const inHand = options.body instanceof Uint8Array ? options.body : null;
  const onDisk = inHand === null ? (options.body as { path: string }) : null;

  const headers = await signS3Request({
    accessKeyId: options.accessKeyId,
    contentType: options.contentType,
    method: "PUT",
    now: options.now ?? new Date(),

    payloadHashSha256: onDisk === null ? undefined : (options.body as { sha256: string }).sha256,
    region: "auto",
    secretAccessKey: options.secretAccessKey,
    service: "s3",
    url,
    ...(inHand === null ? {} : { body: inHand }),
  });

  const sent = { ...headers, "content-type": options.contentType };

  const res =
    onDisk === null
      ? await fetch(url, { body: inHand, headers: sent, method: "PUT" })
      : await fetch(url, { body: Bun.file(onDisk.path), headers: sent, method: "PUT" });

  if (!res.ok) {
    throw new Error(`R2 PUT ${url} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
}

async function r2PutBytes(key: string, body: Uint8Array, contentType: string): Promise<void> {
  await signedPut(`${R2.bucketUrl}/${encodeKey(key)}`, {
    accessKeyId: R2.accessKeyId,
    body,
    contentType,
    secretAccessKey: R2.secretAccessKey,
  });
}

async function r2PutFile(key: string, file: ArtifactFile, contentType: string): Promise<void> {
  await signedPut(`${R2.bucketUrl}/${encodeKey(key)}`, {
    accessKeyId: R2.accessKeyId,
    body: { bytes: file.bytes, path: file.path, sha256: file.sha256 },
    contentType,
    secretAccessKey: R2.secretAccessKey,
  });
}

async function r2Delete(key: string): Promise<void> {
  const url = `${R2.bucketUrl}/${encodeKey(key)}`;
  const headers = await signS3Request({
    accessKeyId: R2.accessKeyId,
    method: "DELETE",
    now: new Date(),
    region: "auto",
    secretAccessKey: R2.secretAccessKey,
    service: "s3",
    url,
  });
  const res = await fetch(url, { headers, method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new Error(`R2 DELETE ${key} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
}

export async function signedList(options: {
  accessKeyId: string;
  bucketUrl: string;
  prefix: string;
  secretAccessKey: string;
}): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const url = new URL(options.bucketUrl);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", options.prefix);
    if (token) {
      url.searchParams.set("continuation-token", token);
    }
    const headers = await signS3Request({
      accessKeyId: options.accessKeyId,
      method: "GET",
      now: new Date(),
      region: "auto",
      secretAccessKey: options.secretAccessKey,
      service: "s3",
      url: url.toString(),
    });
    const res = await fetch(url.toString(), { headers, method: "GET" });
    if (!res.ok) {
      throw new Error(`R2 LIST failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    const xml = await res.text();
    for (const match of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
      if (match[1]) {
        keys.push(match[1]);
      }
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    token = truncated
      ? (xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] ?? undefined)
      : undefined;
  } while (token);
  return keys;
}

async function r2List(prefix: string): Promise<string[]> {
  return signedList({
    accessKeyId: R2.accessKeyId,
    bucketUrl: R2.bucketUrl,
    prefix,
    secretAccessKey: R2.secretAccessKey,
  });
}

export type DumpManifest = {
  generatedAt: string;
  source: string;
  spot: {
    column: string;
    count: number;
    max: string | null;
    min: string | null;
    table: string;
  } | null;
  sqlBytes: number;
  tableCount: number;
  tables: Record<string, number>;
};

export type DumpSource = {
  fetchSchema: () => Promise<SchemaObject[]>;

  fetchPage: (
    table: string,
    limit: number,
    offset: number,
  ) => Promise<{ columns: string[]; rows: SqlValue[][] } | null>;

  fetchSpot: (
    table: string,
    column: string,
  ) => Promise<{ count: number; max: unknown; min: unknown } | null>;
};

export type DumpWriter = (chunk: string) => Promise<void> | void;

export async function streamDumpSql(
  source: DumpSource,
  write: DumpWriter,
  options: { batchRows?: number; generatedAt: Date; header: string; sourceName: string },
): Promise<DumpManifest> {
  const batchRows = Math.max(1, options.batchRows ?? ROW_BATCH);

  let sqlBytes = 0;
  let pending: string[] = [];
  let pendingBytes = 0;

  const flush = async (): Promise<void> => {
    if (pending.length === 0) {
      return;
    }
    const chunk = pending.join("");
    pending = [];
    pendingBytes = 0;
    await write(chunk);
  };

  const emit = async (part: string): Promise<void> => {
    const line = `${part}\n`;
    sqlBytes += Buffer.byteLength(line, "utf8");
    pending.push(line);
    pendingBytes += line.length;

    if (pendingBytes >= WRITE_CHUNK_BYTES) {
      await flush();
    }
  };

  const schema = await source.fetchSchema();

  await emit(options.header);
  await emit("PRAGMA foreign_keys=OFF;");
  await emit("BEGIN TRANSACTION;");

  for (const object of schema) {
    if (object.type === "table") {
      await emit(`${object.sql};`);
    }
  }

  const tableCounts: Record<string, number> = {};
  const anchorCandidates: { firstColumn: string; name: string; rowCount: number }[] = [];
  let tableCount = 0;

  for (const object of schema) {
    if (object.type !== "table") {
      continue;
    }

    const first = await source.fetchPage(object.name, batchRows, 0);

    if (!first) {
      continue;
    }

    tableCount += 1;

    const columnList = first.columns.map(quoteIdent).join(", ");
    const target = quoteIdent(object.name);
    let page = first;
    let rowCount = 0;

    for (;;) {
      for (const row of page.rows) {
        await emit(
          `INSERT INTO ${target} (${columnList}) VALUES (${row.map(sqlLiteral).join(", ")});`,
        );
      }

      rowCount += page.rows.length;

      if (page.rows.length < batchRows) {
        break;
      }

      const next = await source.fetchPage(object.name, batchRows, rowCount);

      if (!next || next.rows.length === 0) {
        break;
      }

      page = next;
    }

    tableCounts[object.name] = rowCount;
    anchorCandidates.push({
      firstColumn: first.columns[0] ?? "",
      name: object.name,
      rowCount,
    });
  }

  for (const object of schema) {
    if (object.type !== "table") {
      await emit(`${object.sql};`);
    }
  }

  await emit("COMMIT;");
  await flush();

  const anchor = chooseAnchor(anchorCandidates);
  let spot: DumpManifest["spot"] = null;

  if (anchor) {
    const row = await source.fetchSpot(anchor.table, anchor.column);

    if (row) {
      spot = {
        column: anchor.column,
        count: row.count,
        max: spotCell(row.max),
        min: spotCell(row.min),
        table: anchor.table,
      };
    }
  }

  return {
    generatedAt: options.generatedAt.toISOString(),
    source: options.sourceName,
    spot,
    sqlBytes,
    tableCount,
    tables: tableCounts,
  };
}

export type ArtifactFile = { bytes: number; path: string; sha256: string };

export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of Bun.file(path).stream()) {
    hash.update(chunk);
  }

  return hash.digest("hex");
}

export async function writeGzippedDump(
  source: DumpSource,
  path: string,
  options: { batchRows?: number; generatedAt: Date; header: string; sourceName: string },
): Promise<{ file: ArtifactFile; manifest: DumpManifest }> {
  const gzip = createGzip({ level: 6 });
  const done = streamPipeline(gzip, createWriteStream(path));

  const manifest = await streamDumpSql(
    source,
    async (chunk) => {
      if (!gzip.write(chunk)) {
        await once(gzip, "drain");
      }
    },
    options,
  );

  gzip.end();
  await done;

  return {
    file: { bytes: statSync(path).size, path, sha256: await hashFile(path) },
    manifest,
  };
}

function libsqlSource(): DumpSource {
  return {
    fetchPage: async (table, limit, offset) => {
      const [result] = await pipeline([
        `SELECT * FROM ${quoteIdent(table)} LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
      ]);

      if (!result) {
        return null;
      }

      return {
        columns: result.cols.map((col) => col.name),
        rows: result.rows.map((row) => row.map((cell) => decodeCell(cell))),
      };
    },

    fetchSchema: async () => {
      const [schemaResult] = await pipeline([
        `SELECT type, name, sql FROM sqlite_master
     WHERE sql IS NOT NULL
       AND name NOT LIKE 'sqlite_%'
       AND name NOT LIKE 'libsql_%'
       AND name NOT LIKE '_litestream%'
     ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END, name`,
      ]);

      if (!schemaResult) {
        throw new Error("no schema returned from libSQL");
      }

      return schemaResult.rows.map((row) => ({
        name: decodeCell(row[1] as HranaCell) as string,
        sql: decodeCell(row[2] as HranaCell) as string,
        type: decodeCell(row[0] as HranaCell) as string,
      }));
    },

    fetchSpot: async (table, column) => {
      const [result] = await pipeline([
        `SELECT count(*) AS c, min(${quoteIdent(column)}) AS mn, max(${quoteIdent(
          column,
        )}) AS mx FROM ${quoteIdent(table)}`,
      ]);
      const row = result?.rows[0];

      if (!row) {
        return null;
      }

      return {
        count: Number(decodeCell(row[0] as HranaCell)),
        max: decodeCell(row[2] as HranaCell),
        min: decodeCell(row[1] as HranaCell),
      };
    },
  };
}

async function uploadTier(options: {
  artifact: ArtifactFile;
  artifactName: string;
  contentType: string;
  dailyPrefix: string;
  date: string;
  existing: string[];
  keepDaily: number;
  keepMonthly: number;
  manifestJson: string;
  month: string;
  monthlyPrefix: string;
}): Promise<{ dailyKey: string; monthlyWritten: boolean; pruned: number }> {
  const dailyArtifact = `${options.dailyPrefix}${options.date}/${options.artifactName}`;
  const dailyManifest = `${options.dailyPrefix}${options.date}/${MANIFEST_NAME}`;
  const monthlyArtifact = `${options.monthlyPrefix}${options.month}/${options.artifactName}`;
  const monthlyManifest = `${options.monthlyPrefix}${options.month}/${MANIFEST_NAME}`;
  const manifestBytes = Buffer.from(options.manifestJson, "utf8");

  await r2PutFile(dailyArtifact, options.artifact, options.contentType);
  await r2PutBytes(dailyManifest, manifestBytes, "application/json");

  const monthlyExists = options.existing.some((key) =>
    key.startsWith(`${options.monthlyPrefix}${options.month}/`),
  );

  if (!monthlyExists) {
    await r2PutFile(monthlyArtifact, options.artifact, options.contentType);
    await r2PutBytes(monthlyManifest, manifestBytes, "application/json");
  }

  const allKeys = new Set([
    ...options.existing,
    dailyArtifact,
    dailyManifest,
    ...(monthlyExists ? [] : [monthlyArtifact, monthlyManifest]),
  ]);
  const expired = selectExpiredBackupKeys([...allKeys], {
    dailyPrefix: options.dailyPrefix,
    keepDaily: options.keepDaily,
    keepMonthly: options.keepMonthly,
    monthlyPrefix: options.monthlyPrefix,
  });

  for (const key of expired) {
    await r2Delete(key);
  }

  return { dailyKey: dailyArtifact, monthlyWritten: !monthlyExists, pruned: expired.length };
}

export function reusableDailyDump(options: {
  date: string;
  existing: readonly string[];
  retryState: string | undefined;
}): string | null {
  if (options.retryState !== "partial") {
    return null;
  }
  const folder = `${DAILY_PREFIX}${options.date}/`;
  const artifact = `${folder}fluncle.sql.gz`;

  return options.existing.includes(artifact) &&
    options.existing.includes(`${folder}${MANIFEST_NAME}`)
    ? artifact
    : null;
}

type BoxStateOutcome =
  | { key: string; manifest: BoxStateManifest; ok: true; pruned: number }
  | { error: string; ok: false };

export type BackupRunCounters = {
  checked: number;
  errors: number;
  failed: number;
  produced: number;
};

export function createBackupRunCounters(): BackupRunCounters {
  return { checked: 0, errors: 0, failed: 0, produced: 0 };
}

export function beginBackupOperation(counters: BackupRunCounters): void {
  counters.checked += 1;
}

export function completeBackupOperation(counters: BackupRunCounters): void {
  counters.produced += 1;
}

export function failBackupOperation(counters: BackupRunCounters): void {
  counters.failed += 1;
}

const runCounters = createBackupRunCounters();

function resetRunCounters(): void {
  runCounters.checked = 0;
  runCounters.errors = 0;
  runCounters.failed = 0;
  runCounters.produced = 0;
}

async function runBoxStateLeg(now: Date, tempDir: string): Promise<BoxStateOutcome> {
  const key = boxStateKeyFromEnv(process.env);

  if (!key) {
    return { error: "no_encryption_key", ok: false };
  }

  const paths = selectBoxStatePaths(boxStateCandidates());
  const archivePath = join(tempDir, BOXSTATE_ARTIFACT_NAME);

  try {
    const { file, manifest } = await buildBoxStateArchive({
      generatedAt: now,
      key,
      outPath: archivePath,
      paths,
      tempDir,
    });

    const artifact: ArtifactFile = { ...file, sha256: await hashFile(file.path) };
    const date = now.toISOString().slice(0, 10);
    const month = now.toISOString().slice(0, 7);
    const existing = await r2List(BOXSTATE_PREFIX);

    const tier = await uploadTier({
      artifact,
      artifactName: BOXSTATE_ARTIFACT_NAME,
      contentType: "application/octet-stream",
      dailyPrefix: BOXSTATE_DAILY_PREFIX,
      date,
      existing,
      keepDaily: BOXSTATE_KEEP_DAILY,
      keepMonthly: BOXSTATE_KEEP_MONTHLY,
      manifestJson: `${JSON.stringify(manifest, null, 2)}\n`,
      month,
      monthlyPrefix: BOXSTATE_MONTHLY_PREFIX,
    });

    return { key: tier.dailyKey, manifest, ok: true, pruned: tier.pruned };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      ok: false,
    };
  } finally {
    await rm(archivePath, { force: true });
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  const now = new Date();
  resetRunCounters();

  if (OUT_DIR !== undefined && BOX_STATE_OUT_DIR !== undefined) {
    console.log(
      JSON.stringify({
        ...runCounters,
        errors: 1,
        ok: false,
        reason: "out_and_box_state_out_are_exclusive",
      }),
    );
    process.exit(1);
  }

  if (BOX_STATE_OUT_DIR !== undefined) {
    mkdirSync(BOX_STATE_OUT_DIR, { recursive: true });
    const key = boxStateKeyFromEnv(process.env);

    if (!key) {
      console.log(
        JSON.stringify({
          ...runCounters,
          errors: 1,
          ok: false,
          reason: "no_encryption_key",
        }),
      );
      process.exit(1);
    }

    beginBackupOperation(runCounters);
    const { file, manifest } = await buildBoxStateArchive({
      generatedAt: now,
      key,
      outPath: join(BOX_STATE_OUT_DIR, BOXSTATE_ARTIFACT_NAME),
      paths: selectBoxStatePaths(boxStateCandidates()),
      tempDir: BOX_STATE_OUT_DIR,
    });

    writeFileSync(join(BOX_STATE_OUT_DIR, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
    completeBackupOperation(runCounters);
    console.log(
      JSON.stringify({
        ...runCounters,
        cipherBytes: file.bytes,
        dryRun: true,
        elapsedMs: Date.now() - started,
        entryCount: manifest.entryCount,
        ok: true,
        out: BOX_STATE_OUT_DIR,
      }),
    );
    return;
  }

  if (!TURSO_URL) {
    console.log(
      JSON.stringify({ ...runCounters, errors: 1, ok: false, reason: "missing_turso_url" }),
    );
    process.exit(1);
  }

  const dumpOptions = {
    generatedAt: now,
    header: `-- Fluncle database backup. Generated by fluncle-backup (backup-sweep.ts) at ${now.toISOString()}. Do not edit by hand.`,
    sourceName: DRY_RUN ? "local-dev" : "fluncle-prod",
  };

  if (OUT_DIR !== undefined) {
    mkdirSync(OUT_DIR, { recursive: true });

    beginBackupOperation(runCounters);
    const { file, manifest } = await writeGzippedDump(
      libsqlSource(),
      join(OUT_DIR, "fluncle.sql.gz"),
      dumpOptions,
    );

    writeFileSync(join(OUT_DIR, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
    completeBackupOperation(runCounters);
    console.log(
      JSON.stringify({
        ...runCounters,
        dryRun: true,
        elapsedMs: Date.now() - started,
        gzipBytes: file.bytes,
        ok: true,
        out: OUT_DIR,
        sqlBytes: manifest.sqlBytes,
        tableCount: manifest.tableCount,
      }),
    );
    return;
  }

  if (!R2.accountId || !R2.accessKeyId || !R2.secretAccessKey) {
    console.log(
      JSON.stringify({
        ...runCounters,
        errors: 1,
        ok: false,
        reason: "missing_r2_credentials",
      }),
    );
    process.exit(1);
  }

  const tempDir = process.env.FLUNCLE_BACKUP_TMPDIR ?? tmpdir();
  mkdirSync(tempDir, { recursive: true });

  const date = now.toISOString().slice(0, 10);
  const month = now.toISOString().slice(0, 7);
  const existingDumps = await r2List(PREFIX);
  const reusedDailyKey = reusableDailyDump({
    date,
    existing: existingDumps,
    retryState: process.env.FLUNCLE_DAILY_RETRY_STATE,
  });
  let dump: { file: ArtifactFile; manifest: DumpManifest } | null = null;
  let tier: { dailyKey: string; monthlyWritten: boolean; pruned: number };

  if (reusedDailyKey !== null) {
    log(
      `today's database artifact ${reusedDailyKey} already landed; running the box-state leg only`,
    );
    tier = { dailyKey: reusedDailyKey, monthlyWritten: false, pruned: 0 };
  } else {
    const dumpPath = join(tempDir, `fluncle-backup-${process.pid}.sql.gz`);

    beginBackupOperation(runCounters);
    try {
      const written = await writeGzippedDump(libsqlSource(), dumpPath, dumpOptions);
      dump = written;

      tier = await uploadTier({
        artifact: written.file,
        artifactName: "fluncle.sql.gz",
        contentType: "application/gzip",
        dailyPrefix: DAILY_PREFIX,
        date,
        existing: existingDumps,
        keepDaily: KEEP_DAILY,
        keepMonthly: KEEP_MONTHLY,
        manifestJson: `${JSON.stringify(written.manifest, null, 2)}\n`,
        month,
        monthlyPrefix: MONTHLY_PREFIX,
      });
      completeBackupOperation(runCounters);
    } finally {
      await rm(dumpPath, { force: true });
    }
  }

  beginBackupOperation(runCounters);

  const boxState = await runBoxStateLeg(now, tempDir);

  if (!boxState.ok) {
    failBackupOperation(runCounters);
    log(`box-state leg failed: ${boxState.error}`);
  } else {
    completeBackupOperation(runCounters);
  }

  console.log(
    JSON.stringify({
      ...runCounters,
      boxState: boxState.ok
        ? {
            cipherBytes: boxState.manifest.cipherBytes,
            entryCount: boxState.manifest.entryCount,
            key: boxState.key,
            pruned: boxState.pruned,
          }
        : { error: boxState.error, ok: false },
      dailyKey: tier.dailyKey,
      dumpReused: dump === null,
      elapsedMs: Date.now() - started,
      gzipBytes: dump?.file.bytes ?? null,
      monthlyWritten: tier.monthlyWritten,
      ok: boxState.ok,
      pruned: tier.pruned,
      ...(boxState.ok ? {} : { reason: "box_state_failed" }),
      sqlBytes: dump?.manifest.sqlBytes ?? null,
      tableCount: dump?.manifest.tableCount ?? null,
    }),
  );
  if (!boxState.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log(`backup failed: ${message}`);
    console.log(
      JSON.stringify({
        ...runCounters,
        error: message,
        errors: 1,
        ok: false,
        reason: "backup_failed",
      }),
    );
    process.exit(1);
  });
}
