#!/usr/bin/env bun
// backup-sweep.ts — the bun orchestrator behind the `--no-agent` database-backup
// cron (`fluncle-backup`). Dumps the PRODUCTION Turso (libSQL) database to a gzipped
// SQL artifact and uploads it — plus an integrity manifest — to a PRIVATE R2 bucket,
// then prunes to the retention window. An OWNED, off-Cloudflare backup: it runs on the
// box and talks to Turso + R2 directly, so a Worker/Cloudflare fault can't also take out
// the backup. Turso's managed point-in-time restore is the belt; this is the braces.
//
// LIVE. Version-controlled source; the repo is canonical and the box is a deploy
// target (fluncle-hermes-operator skill). Invoked by the bash wrapper (backup-sweep.sh)
// the cron runner execs on a schedule — see that file's header for the wire-up and
// ../cron/README.md § The database-backup cron for the operator runbook.
//
// SELF-CONTAINED by necessity: box scripts can't import the workspace. The pure dump
// FORMAT (`sqlLiteral` / `quoteIdent` / `buildDumpSql` / `chooseAnchor` /
// `selectExpiredBackupKeys`) MIRRORS apps/web/src/lib/server/db-dump.ts and the S3
// signer MIRRORS apps/web/src/lib/server/aws-sigv4.ts — keep them in step (the same
// discipline the healthcheck prober uses for the registry). Both mirrors are unit-tested
// on the repo side; the whole artifact is proven end-to-end by the restore drill
// (apps/web/scripts/restore-drill.ts), which restores exactly this format.
//
// THE DUMP METHOD: the libSQL HTTP pipeline (POST <http-url>/v2/pipeline, Bearer auth) —
// the same over-the-wire access `db-pull-prod.ts` uses via @libsql/client, but with no
// dependency, so it runs on the box with only bun. No `turso` CLI, no image change.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.
//
// Modes:
//   (default)         dump → gzip → upload to R2 (daily + monthly) → prune. Needs the
//                     Turso creds + the backup-bucket R2 creds in the env.
//   --out <dir>       LOCAL DRY RUN: dump → gzip → write <dir>/fluncle.sql.gz +
//                     <dir>/manifest.json, NO R2. Used to verify against the local dev db
//                     and to feed the restore drill. Needs only the Turso creds.

import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Config (env; the shared .fluncle-secrets.env supplies the secrets on the box) ──

const OUT_INDEX = process.argv.indexOf("--out");
const OUT_DIR = OUT_INDEX >= 0 ? process.argv[OUT_INDEX + 1] : undefined;
const DRY_RUN = OUT_DIR !== undefined;

const TURSO_URL = process.env.TURSO_DATABASE_URL ?? "";
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN ?? "";

// A dedicated, least-privilege R2 token: Object Read & Write on the PRIVATE backup
// bucket ONLY (never fluncle-videos, which is world-served at found.fluncle.com).
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID ?? "";
const R2_ACCESS_KEY_ID = process.env.FLUNCLE_BACKUP_R2_ACCESS_KEY_ID ?? "";
const R2_SECRET_ACCESS_KEY = process.env.FLUNCLE_BACKUP_R2_SECRET_ACCESS_KEY ?? "";
const R2_BUCKET = process.env.FLUNCLE_BACKUP_R2_BUCKET ?? "fluncle-backups";

const KEEP_DAILY = Number(process.env.FLUNCLE_BACKUP_KEEP_DAILY ?? "30");
const KEEP_MONTHLY = Number(process.env.FLUNCLE_BACKUP_KEEP_MONTHLY ?? "12");
const DISCORD_ALERT_WEBHOOK = process.env.DISCORD_ALERT_WEBHOOK ?? "";

const PREFIX = "db-backups/";
const DAILY_PREFIX = `${PREFIX}daily/`;
const MONTHLY_PREFIX = `${PREFIX}monthly/`;

const log = (message: string) => console.error(`[backup-sweep] ${message}`);

// ── MIRROR of apps/web/src/lib/server/db-dump.ts — keep in step ──────────────

type SqlValue = ArrayBuffer | ArrayBufferView | bigint | boolean | number | string | null;
type SchemaObject = { name: string; sql: string; type: string };
type DumpTable = { columns: string[]; name: string; rows: SqlValue[][] };

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function sqlLiteral(value: SqlValue): string {
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

function buildDumpSql(
  schema: readonly SchemaObject[],
  tables: readonly DumpTable[],
  header: string,
): string {
  const parts: string[] = [header, "PRAGMA foreign_keys=OFF;", "BEGIN TRANSACTION;"];
  for (const object of schema) {
    if (object.type === "table") {
      parts.push(`${object.sql};`);
    }
  }
  for (const table of tables) {
    if (table.rows.length === 0) {
      continue;
    }
    const columnList = table.columns.map(quoteIdent).join(", ");
    for (const row of table.rows) {
      parts.push(
        `INSERT INTO ${quoteIdent(table.name)} (${columnList}) VALUES (${row.map(sqlLiteral).join(", ")});`,
      );
    }
  }
  for (const object of schema) {
    if (object.type !== "table") {
      parts.push(`${object.sql};`);
    }
  }
  parts.push("COMMIT;");
  return `${parts.join("\n")}\n`;
}

function chooseAnchor(
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

function selectExpiredBackupKeys(
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

// ── MIRROR of apps/web/src/lib/server/aws-sigv4.ts — keep in step ────────────

const encoder = new TextEncoder();
function toHex(buffer: ArrayBuffer): string {
  let hex = "";
  for (const byte of new Uint8Array(buffer)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer));
}
async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as unknown as ArrayBuffer,
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
async function signS3Request(options: {
  accessKeyId: string;
  body?: Uint8Array;
  contentType?: string;
  method: string;
  now: Date;
  region: string;
  secretAccessKey: string;
  service: string;
  url: string;
}): Promise<Record<string, string>> {
  const url = new URL(options.url);
  const stamp = amzDate(options.now);
  const dateStamp = stamp.slice(0, 8);
  const payloadHash = await sha256Hex(options.body ?? new Uint8Array());
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

// ── The libSQL HTTP pipeline client (Hrana over HTTP, zero deps) ─────────────

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
      // text (+ any unrecognised scalar) — the cell value is a JSON primitive.
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

// ── R2 (S3 API) helpers ──────────────────────────────────────────────────────

const R2_ENDPOINT = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

async function r2Put(key: string, body: Uint8Array, contentType: string): Promise<void> {
  const url = `${R2_ENDPOINT}/${R2_BUCKET}/${encodeKey(key)}`;
  const headers = await signS3Request({
    accessKeyId: R2_ACCESS_KEY_ID,
    body,
    contentType,
    method: "PUT",
    now: new Date(),
    region: "auto",
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    service: "s3",
    url,
  });
  const res = await fetch(url, {
    body,
    headers: { ...headers, "content-type": contentType },
    method: "PUT",
  });
  if (!res.ok) {
    throw new Error(`R2 PUT ${key} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
}

async function r2Delete(key: string): Promise<void> {
  const url = `${R2_ENDPOINT}/${R2_BUCKET}/${encodeKey(key)}`;
  const headers = await signS3Request({
    accessKeyId: R2_ACCESS_KEY_ID,
    method: "DELETE",
    now: new Date(),
    region: "auto",
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    service: "s3",
    url,
  });
  const res = await fetch(url, { headers, method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new Error(`R2 DELETE ${key} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
}

async function r2List(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const url = new URL(`${R2_ENDPOINT}/${R2_BUCKET}`);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    if (token) {
      url.searchParams.set("continuation-token", token);
    }
    const headers = await signS3Request({
      accessKeyId: R2_ACCESS_KEY_ID,
      method: "GET",
      now: new Date(),
      region: "auto",
      secretAccessKey: R2_SECRET_ACCESS_KEY,
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

// ── The dump: schema → tables → SQL + manifest ────────────────────────────────

type DumpManifest = {
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

async function produceDump(): Promise<{ manifest: DumpManifest; sql: string }> {
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

  const schema: SchemaObject[] = schemaResult.rows.map((row) => ({
    name: decodeCell(row[1] as HranaCell) as string,
    sql: decodeCell(row[2] as HranaCell) as string,
    type: decodeCell(row[0] as HranaCell) as string,
  }));

  const tables: DumpTable[] = [];
  const tableCounts: Record<string, number> = {};

  for (const object of schema) {
    if (object.type !== "table") {
      continue;
    }
    const [result] = await pipeline([`SELECT * FROM ${quoteIdent(object.name)}`]);
    if (!result) {
      continue;
    }
    const columns = result.cols.map((col) => col.name);
    tables.push({
      columns,
      name: object.name,
      rows: result.rows.map((row) => row.map((cell) => decodeCell(cell))),
    });
    tableCounts[object.name] = result.rows.length;
  }

  const anchor = chooseAnchor(
    tables.map((table) => ({
      firstColumn: table.columns[0] ?? "",
      name: table.name,
      rowCount: table.rows.length,
    })),
  );

  let spot: DumpManifest["spot"] = null;
  if (anchor) {
    const [result] = await pipeline([
      `SELECT count(*) AS c, min(${quoteIdent(anchor.column)}) AS mn, max(${quoteIdent(
        anchor.column,
      )}) AS mx FROM ${quoteIdent(anchor.table)}`,
    ]);
    const row = result?.rows[0];
    if (row) {
      spot = {
        column: anchor.column,
        count: Number(decodeCell(row[0] as HranaCell)),
        max: spotCell(decodeCell(row[2] as HranaCell)),
        min: spotCell(decodeCell(row[1] as HranaCell)),
        table: anchor.table,
      };
    }
  }

  const sql = buildDumpSql(
    schema,
    tables,
    `-- Fluncle database backup. Generated by fluncle-backup (backup-sweep.ts) at ${new Date().toISOString()}. Do not edit by hand.`,
  );

  const manifest: DumpManifest = {
    generatedAt: new Date().toISOString(),
    source: DRY_RUN ? "local-dev" : "fluncle-prod",
    spot,
    sqlBytes: Buffer.byteLength(sql, "utf8"),
    tableCount: tables.length,
    tables: tableCounts,
  };

  return { manifest, sql };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function alertDiscord(message: string): Promise<void> {
  if (!DISCORD_ALERT_WEBHOOK) {
    return;
  }
  try {
    await fetch(DISCORD_ALERT_WEBHOOK, {
      body: JSON.stringify({ content: message }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* best-effort */
  }
}

async function main(): Promise<void> {
  const started = Date.now();

  if (!TURSO_URL) {
    console.log(JSON.stringify({ ok: false, reason: "missing_turso_url" }));
    process.exit(1);
  }

  const { manifest, sql } = await produceDump();
  const gz = gzipSync(Buffer.from(sql, "utf8"));
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;

  // LOCAL DRY RUN: write the artifacts to a directory, skip R2 entirely.
  if (DRY_RUN && OUT_DIR) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, "fluncle.sql.gz"), gz);
    writeFileSync(join(OUT_DIR, "manifest.json"), manifestJson);
    console.log(
      JSON.stringify({
        dryRun: true,
        elapsedMs: Date.now() - started,
        gzipBytes: gz.byteLength,
        ok: true,
        out: OUT_DIR,
        sqlBytes: manifest.sqlBytes,
        tableCount: manifest.tableCount,
      }),
    );
    return;
  }

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    console.log(JSON.stringify({ ok: false, reason: "missing_r2_credentials" }));
    process.exit(1);
  }

  const now = new Date();
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const month = now.toISOString().slice(0, 7); // YYYY-MM

  const dailyDump = `${DAILY_PREFIX}${date}/fluncle.sql.gz`;
  const dailyManifest = `${DAILY_PREFIX}${date}/manifest.json`;
  const monthlyDump = `${MONTHLY_PREFIX}${month}/fluncle.sql.gz`;
  const monthlyManifest = `${MONTHLY_PREFIX}${month}/manifest.json`;

  // Snapshot the current keyspace once (for the monthly-exists check + prune).
  const existing = await r2List(PREFIX);

  await r2Put(dailyDump, gz, "application/gzip");
  await r2Put(dailyManifest, Buffer.from(manifestJson, "utf8"), "application/json");

  // Promote the FIRST successful backup of each month to the monthly tier.
  const monthlyExists = existing.some((key) => key.startsWith(`${MONTHLY_PREFIX}${month}/`));
  if (!monthlyExists) {
    await r2Put(monthlyDump, gz, "application/gzip");
    await r2Put(monthlyManifest, Buffer.from(manifestJson, "utf8"), "application/json");
  }

  // Prune to the retention window over the full (existing + just-uploaded) keyspace.
  const allKeys = new Set([
    ...existing,
    dailyDump,
    dailyManifest,
    ...(monthlyExists ? [] : [monthlyDump, monthlyManifest]),
  ]);
  const expired = selectExpiredBackupKeys([...allKeys], {
    dailyPrefix: DAILY_PREFIX,
    keepDaily: KEEP_DAILY,
    keepMonthly: KEEP_MONTHLY,
    monthlyPrefix: MONTHLY_PREFIX,
  });
  for (const key of expired) {
    await r2Delete(key);
  }

  console.log(
    JSON.stringify({
      dailyKey: dailyDump,
      elapsedMs: Date.now() - started,
      gzipBytes: gz.byteLength,
      monthlyWritten: !monthlyExists,
      ok: true,
      pruned: expired.length,
      sqlBytes: manifest.sqlBytes,
      tableCount: manifest.tableCount,
    }),
  );
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  log(`backup failed: ${message}`);
  await alertDiscord(`Fluncle backup-sweep failed: ${message}`);
  console.log(JSON.stringify({ error: message, ok: false, reason: "backup_failed" }));
  process.exit(1);
});
