#!/usr/bin/env bun
// backup-sweep.ts — the bun orchestrator behind the `--no-agent` database-backup
// cron (`fluncle-backup`). TWO LEGS, one nightly run:
//
//   LEG 1 (the database) — dumps the PRODUCTION Turso (libSQL) database to a gzipped
//   SQL artifact and uploads it — plus an integrity manifest — to a PRIVATE R2 bucket,
//   then prunes to the retention window. An OWNED, off-Cloudflare backup: it runs on the
//   box and talks to Turso + R2 directly, so a Worker/Cloudflare fault can't also take out
//   the backup. Turso's managed point-in-time restore is the belt; this is the braces.
//
//   LEG 2 (the box's own state) — snapshots the LOAD-BEARING subset of the agent data dir
//   (gateway state db, memories, the render conductor's box-id + poison ledger, the
//   hand-placed 0600 env files, the cron markers), ENCRYPTS it, and uploads it beside the
//   dump under its own prefix + retention. See box-state-snapshot.ts for the include /
//   exclude list and the encryption contract. This leg is SKIPPED (never a plaintext
//   tarball) until the operator provisions FLUNCLE_BOXSTATE_KEY.
//
// LIVE. Version-controlled source; the repo is canonical and the box is a deploy
// target (fluncle-hermes-operator skill). Invoked by the bash wrapper (backup-sweep.sh)
// the cron runner execs on a schedule — see that file's header for the wire-up and
// ../backup-timer/README.md for the operator runbook of BOTH legs.
//
// SELF-CONTAINED by necessity: box scripts can't import the workspace. The pure dump
// FORMAT (`sqlLiteral` / `quoteIdent` / `chooseAnchor` / `selectExpiredBackupKeys`)
// MIRRORS apps/web/src/lib/server/db-dump.ts and the S3 signer MIRRORS
// apps/web/src/lib/server/aws-sigv4.ts — keep them in step (the same discipline the
// healthcheck prober uses for the registry).
//
// TWO DELIBERATE DIVERGENCES FROM THE MIRRORS (2026-07-26, the OOM fix):
//   1. `buildDumpSql` (returns the whole dump as ONE string) is NOT mirrored here any
//      more — this file has `streamDumpSql`, which emits the SAME BYTES incrementally
//      into a writer instead of materialising them. The repo-side builder stays as it is
//      (a Worker holding a dev-seed dump is a different, bounded problem). The equivalence
//      is ENFORCED, not asserted: backup-sweep.test.ts imports the real `buildDumpSql`
//      from apps/web/src/lib/server/db-dump.ts and asserts byte-for-byte equality with the
//      streamed output. If the repo-side builder changes, that test goes red.
//   2. `signS3Request` gains an OPTIONAL `payloadHashSha256` so a caller can sign a body
//      it never holds in memory (the gzip file is hashed by streaming it). Omit it and the
//      function behaves exactly as the mirror does.
//
// WHY THIS FILE IS STREAMING (the incident, so nobody re-flattens it). Until 2026-07-26 the
// sweep built the entire dump as one JavaScript string, then `Buffer.from(sql)`, then
// `gzipSync(...)` — three simultaneous full copies of the payload, and a JS string is UTF-16,
// so the 323 MB dump of 2026-07-23 wanted ≈650 MB for the string alone. The container is
// capped at 4 GiB with no swap; the sweep was OOM-killed (status=137, CONSTRAINT_MEMCG) on
// three consecutive nights (Jul 24/25/26) and the last good backup was Jul 23. That shape
// never self-heals — it worsens as the archive grows. So: rows are paged out of libSQL a
// batch at a time, rendered straight into a gzip stream, and the gzip lands in a temp FILE
// that is uploaded by streaming it back. Peak RSS is bounded by the page size, not the
// database size. Keep it that way: never join the dump, never `Buffer.from` it, never read
// the artifact back with `readFileSync`.
//
// THE DUMP METHOD: the libSQL HTTP pipeline (POST <http-url>/v2/pipeline, Bearer auth) —
// the same over-the-wire access `db-pull-prod.ts` uses via @libsql/client, but with no
// dependency, so it runs on the box with only bun. No `turso` CLI, no image change.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.
//
// Modes:
//   (default)              both legs → upload to R2 (daily + monthly) → prune. Needs the
//                          Turso creds + the backup-bucket R2 creds in the env.
//   --out <dir>            LOCAL DRY RUN of LEG 1: dump → gzip → write <dir>/fluncle.sql.gz
//                          + <dir>/manifest.json, NO R2. Used to verify against the local
//                          dev db and to feed the restore drill. Needs only the Turso creds.
//   --box-state-out <dir>  LOCAL DRY RUN of LEG 2: build + encrypt the box-state archive
//                          into <dir>, NO R2. Needs only FLUNCLE_BOXSTATE_KEY.

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

// ── Config (env; the shared .fluncle-secrets.env supplies the secrets on the box) ──

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);

  return index >= 0 ? process.argv[index + 1] : undefined;
}

const OUT_DIR = argValue("--out");
const BOX_STATE_OUT_DIR = argValue("--box-state-out");
const DRY_RUN = OUT_DIR !== undefined || BOX_STATE_OUT_DIR !== undefined;

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

// Leg 2 keeps a SHORTER window than the database: box state is operational scaffolding
// (re-derivable in part, and stale copies age badly), the database is the archive.
const BOXSTATE_KEEP_DAILY = Number(process.env.FLUNCLE_BOXSTATE_KEEP_DAILY ?? "14");
const BOXSTATE_KEEP_MONTHLY = Number(process.env.FLUNCLE_BOXSTATE_KEEP_MONTHLY ?? "6");

const DISCORD_ALERT_WEBHOOK = process.env.DISCORD_ALERT_WEBHOOK ?? "";

// How many rows are pulled from libSQL — and held in the isolate — at once. THE memory
// dial: peak RSS scales with this, never with the table's size. 1,000 rows of the widest
// table (tracks, with a MuQ embedding blob) is a few MB of response JSON.
const ROW_BATCH = Math.max(1, Number(process.env.FLUNCLE_BACKUP_ROW_BATCH ?? "1000"));

// Coalesce emitted SQL into ~512 KB writes before pushing them at the gzip stream: one
// `write()` per INSERT is correct but syscall-heavy, and a bounded buffer keeps the
// memory promise intact.
const WRITE_CHUNK_BYTES = 512 * 1024;

const PREFIX = "db-backups/";
const DAILY_PREFIX = `${PREFIX}daily/`;
const MONTHLY_PREFIX = `${PREFIX}monthly/`;

// Leg 2's own keyspace, beside the database's and pruned on its own retention.
const BOXSTATE_PREFIX = "box-state/";
const BOXSTATE_DAILY_PREFIX = `${BOXSTATE_PREFIX}daily/`;
const BOXSTATE_MONTHLY_PREFIX = `${BOXSTATE_PREFIX}monthly/`;

const log = (message: string) => console.error(`[backup-sweep] ${message}`);

// ── MIRROR of apps/web/src/lib/server/db-dump.ts — keep in step ──────────────

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
export async function signS3Request(options: {
  accessKeyId: string;
  body?: Uint8Array;
  contentType?: string;
  method: string;
  now: Date;
  // DIVERGENCE from the mirror: a precomputed payload hash, so a body that is never held
  // in memory (the gzip artifact, hashed by streaming it off disk) can still be signed.
  // Omitted ⇒ hash `body` exactly as the mirror does.
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

/**
 * One signed S3 PUT. `body` is either bytes already in hand (a manifest — always small)
 * or a `{ path, bytes, sha256 }` handle to a file that is STREAMED off disk, so a 100 MB
 * artifact never becomes a 100 MB Buffer. Exported so backup-sweep.test.ts can drive it
 * against a loopback fixture server and prove the streamed PUT carries the right
 * content-length, payload hash, and bytes.
 */
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
    // A file is signed with the hash the CALLER streamed off disk; bytes in hand are hashed
    // here, exactly as the aws-sigv4 mirror always did.
    payloadHashSha256: onDisk === null ? undefined : (options.body as { sha256: string }).sha256,
    region: "auto",
    secretAccessKey: options.secretAccessKey,
    service: "s3",
    url,
    ...(inHand === null ? {} : { body: inHand }),
  });

  const sent = { ...headers, "content-type": options.contentType };

  // Two literal call sites rather than one union-typed body: Bun sets Content-Length from a
  // BunFile and streams it, so the artifact is never resident.
  const res =
    onDisk === null
      ? await fetch(url, { body: inHand, headers: sent, method: "PUT" })
      : await fetch(url, { body: Bun.file(onDisk.path), headers: sent, method: "PUT" });

  if (!res.ok) {
    throw new Error(`R2 PUT ${url} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
}

async function r2PutBytes(key: string, body: Uint8Array, contentType: string): Promise<void> {
  await signedPut(`${R2_ENDPOINT}/${R2_BUCKET}/${encodeKey(key)}`, {
    accessKeyId: R2_ACCESS_KEY_ID,
    body,
    contentType,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  });
}

async function r2PutFile(key: string, file: ArtifactFile, contentType: string): Promise<void> {
  await signedPut(`${R2_ENDPOINT}/${R2_BUCKET}/${encodeKey(key)}`, {
    accessKeyId: R2_ACCESS_KEY_ID,
    body: { bytes: file.bytes, path: file.path, sha256: file.sha256 },
    contentType,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  });
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

// ── LEG 1: the streaming dump ────────────────────────────────────────────────

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

/**
 * Everything `streamDumpSql` needs from the database, as three narrow reads. Injected so
 * the tests can drive the writer with a synthetic table of any size (the memory-bound
 * proof) without a database.
 */
export type DumpSource = {
  /** Every `sqlite_master` object, already ordered tables → indexes → triggers → rest. */
  fetchSchema: () => Promise<SchemaObject[]>;
  /**
   * One page of a table, `limit` rows from `offset`. Returns null when the table cannot be
   * read at all (the old code's `if (!result) continue` — such a table is skipped whole).
   * Rows come back in the table's natural scan order, which is what an un-ORDERed
   * `SELECT *` gave before, so the dump's row order is unchanged.
   */
  fetchPage: (
    table: string,
    limit: number,
    offset: number,
  ) => Promise<{ columns: string[]; rows: SqlValue[][] } | null>;
  /** The manifest's content spot-check over the chosen anchor. */
  fetchSpot: (
    table: string,
    column: string,
  ) => Promise<{ count: number; max: unknown; min: unknown } | null>;
};

/** Where the dump text goes. Called with large-ish coalesced chunks, never per row. */
export type DumpWriter = (chunk: string) => Promise<void> | void;

/**
 * Emit the dump — byte-for-byte what `buildDumpSql` would have returned — into `write`,
 * and return the manifest. Nothing larger than one page of rows plus one ~512 KB text
 * buffer is ever resident, so peak memory is independent of the database size.
 *
 * The order is SQLite's own `.dump` order and must not drift: header, pragma, BEGIN, every
 * CREATE TABLE, every table's INSERTs (empty tables emit none), then indexes/triggers/views,
 * then COMMIT — each part on its own line, with a trailing newline.
 */
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

  // One dump "part" — the same unit `buildDumpSql` joined with "\n".
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
      continue; // unreadable table — skipped whole, exactly as before
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

/** A produced artifact on disk: where it is, how big, and its SHA-256 (for SigV4). */
export type ArtifactFile = { bytes: number; path: string; sha256: string };

/** SHA-256 a file by streaming it — the hash of a 100 MB artifact costs 64 KB of RAM. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of Bun.file(path).stream()) {
    hash.update(chunk);
  }

  return hash.digest("hex");
}

/**
 * Run the dump straight into `path` as gzip. The gzip stream applies backpressure, so a
 * slow disk throttles the reader instead of queueing the dump in memory.
 */
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

/** The production source: the libSQL HTTP pipeline. */
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

/** Upload one artifact + its manifest into a daily folder, promoting the month's first. */
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
  const dailyManifest = `${options.dailyPrefix}${options.date}/manifest.json`;
  const monthlyArtifact = `${options.monthlyPrefix}${options.month}/${options.artifactName}`;
  const monthlyManifest = `${options.monthlyPrefix}${options.month}/manifest.json`;
  const manifestBytes = Buffer.from(options.manifestJson, "utf8");

  await r2PutFile(dailyArtifact, options.artifact, options.contentType);
  await r2PutBytes(dailyManifest, manifestBytes, "application/json");

  // Promote the FIRST successful backup of each month to the monthly tier.
  const monthlyExists = options.existing.some((key) =>
    key.startsWith(`${options.monthlyPrefix}${options.month}/`),
  );

  if (!monthlyExists) {
    await r2PutFile(monthlyArtifact, options.artifact, options.contentType);
    await r2PutBytes(monthlyManifest, manifestBytes, "application/json");
  }

  // Prune to the retention window over the full (existing + just-uploaded) keyspace.
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

type BoxStateOutcome =
  | { key: string; manifest: BoxStateManifest; ok: true; pruned: number; skipped: false }
  | { ok: true; reason: string; skipped: true }
  | { error: string; ok: false; skipped: false };

/** LEG 2 — build, encrypt, upload, prune. Never throws; the caller decides what it means. */
async function runBoxStateLeg(now: Date, tempDir: string): Promise<BoxStateOutcome> {
  const key = boxStateKeyFromEnv(process.env);

  if (!key) {
    // THE PLAINTEXT RAIL: the archive carries 0600 credential-bearing env files, so with no
    // key there is no artifact at all. Never a plaintext tarball, not even once.
    return { ok: true, reason: "no_encryption_key", skipped: true };
  }

  const paths = selectBoxStatePaths(boxStateCandidates());
  const archivePath = join(tempDir, "box-state.tar.gz.enc");

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
      artifactName: "box-state.tar.gz.enc",
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

    return { key: tier.dailyKey, manifest, ok: true, pruned: tier.pruned, skipped: false };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      ok: false,
      skipped: false,
    };
  } finally {
    await rm(archivePath, { force: true });
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  const now = new Date();

  if (OUT_DIR !== undefined && BOX_STATE_OUT_DIR !== undefined) {
    // Two different artifacts with two different verifications — run them one at a time so a
    // dry run's summary always describes exactly one thing.
    console.log(JSON.stringify({ ok: false, reason: "out_and_box_state_out_are_exclusive" }));
    process.exit(1);
  }

  // A LEG-2-ONLY dry run needs no database at all.
  if (BOX_STATE_OUT_DIR !== undefined) {
    mkdirSync(BOX_STATE_OUT_DIR, { recursive: true });
    const key = boxStateKeyFromEnv(process.env);

    if (!key) {
      console.log(JSON.stringify({ ok: false, reason: "no_encryption_key" }));
      process.exit(1);
    }

    const { file, manifest } = await buildBoxStateArchive({
      generatedAt: now,
      key,
      outPath: join(BOX_STATE_OUT_DIR, "box-state.tar.gz.enc"),
      paths: selectBoxStatePaths(boxStateCandidates()),
      tempDir: BOX_STATE_OUT_DIR,
    });

    writeFileSync(
      join(BOX_STATE_OUT_DIR, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    console.log(
      JSON.stringify({
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
    console.log(JSON.stringify({ ok: false, reason: "missing_turso_url" }));
    process.exit(1);
  }

  const dumpOptions = {
    generatedAt: now,
    header: `-- Fluncle database backup. Generated by fluncle-backup (backup-sweep.ts) at ${now.toISOString()}. Do not edit by hand.`,
    sourceName: DRY_RUN ? "local-dev" : "fluncle-prod",
  };

  // LOCAL DRY RUN: write the artifacts to a directory, skip R2 entirely.
  if (OUT_DIR !== undefined) {
    mkdirSync(OUT_DIR, { recursive: true });

    const { file, manifest } = await writeGzippedDump(
      libsqlSource(),
      join(OUT_DIR, "fluncle.sql.gz"),
      dumpOptions,
    );

    writeFileSync(join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(
      JSON.stringify({
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

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    console.log(JSON.stringify({ ok: false, reason: "missing_r2_credentials" }));
    process.exit(1);
  }

  const tempDir = process.env.FLUNCLE_BACKUP_TMPDIR ?? tmpdir();
  mkdirSync(tempDir, { recursive: true });

  const dumpPath = join(tempDir, `fluncle-backup-${process.pid}.sql.gz`);
  let dump: { file: ArtifactFile; manifest: DumpManifest };
  let tier: { dailyKey: string; monthlyWritten: boolean; pruned: number };

  try {
    dump = await writeGzippedDump(libsqlSource(), dumpPath, dumpOptions);

    const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const month = now.toISOString().slice(0, 7); // YYYY-MM

    // Snapshot the current keyspace once (for the monthly-exists check + prune).
    tier = await uploadTier({
      artifact: dump.file,
      artifactName: "fluncle.sql.gz",
      contentType: "application/gzip",
      dailyPrefix: DAILY_PREFIX,
      date,
      existing: await r2List(PREFIX),
      keepDaily: KEEP_DAILY,
      keepMonthly: KEEP_MONTHLY,
      manifestJson: `${JSON.stringify(dump.manifest, null, 2)}\n`,
      month,
      monthlyPrefix: MONTHLY_PREFIX,
    });
  } finally {
    await rm(dumpPath, { force: true });
  }

  // LEG 2 runs only AFTER the database leg is durable in R2, so a box-state fault can
  // never cost the night's dump.
  const boxState = await runBoxStateLeg(now, tempDir);

  if (!boxState.ok) {
    log(`box-state leg failed: ${boxState.error}`);
    await alertDiscord(`Fluncle backup-sweep: the box-state leg failed — ${boxState.error}`);
  }

  // `ok` covers BOTH legs. A half-backup reporting green is the failure mode that let three
  // OOM-killed nights read healthy on /status — the whole run tells the truth or none of it does.
  console.log(
    JSON.stringify({
      boxState: boxState.skipped
        ? { reason: boxState.reason, skipped: true }
        : boxState.ok
          ? {
              cipherBytes: boxState.manifest.cipherBytes,
              entryCount: boxState.manifest.entryCount,
              key: boxState.key,
              pruned: boxState.pruned,
            }
          : { error: boxState.error, ok: false },
      dailyKey: tier.dailyKey,
      elapsedMs: Date.now() - started,
      gzipBytes: dump.file.bytes,
      monthlyWritten: tier.monthlyWritten,
      ok: boxState.ok,
      pruned: tier.pruned,
      ...(boxState.ok ? {} : { reason: "box_state_failed" }),
      sqlBytes: dump.manifest.sqlBytes,
      tableCount: dump.manifest.tableCount,
    }),
  );
}

if (import.meta.main) {
  main().catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log(`backup failed: ${message}`);
    await alertDiscord(`Fluncle backup-sweep failed: ${message}`);
    console.log(JSON.stringify({ error: message, ok: false, reason: "backup_failed" }));
    process.exit(1);
  });
}
