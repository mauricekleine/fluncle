#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type BoxCostEvent, emitCost, selfSecondsCost } from "./cost-emit";
import {
  databaseAdmissionYieldSummary,
  runDatabaseAdmissionPhase,
} from "./database-admission-phase";
import {
  dueWorkRepairPendingSummary,
  failureBodyUnlessRepairPending,
  isDueWorkRepairPending,
  throwIfPageRepairPending,
} from "./due-work-repair-pending";

export const DEFAULT_EMBED_BATCH_CAP = 3;
export const MAX_EMBED_BATCH_CAP = 6;

export const resolveEmbedBatchCap = (raw: string | undefined): number => {
  const trimmed = raw?.trim() ?? "";

  if (trimmed === "") {
    return DEFAULT_EMBED_BATCH_CAP;
  }

  const parsed = Number(trimmed);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_EMBED_BATCH_CAP) {
    console.error(
      `[embed-sweep] FLUNCLE_EMBED_BATCH=${JSON.stringify(raw)} is not an integer 1-${MAX_EMBED_BATCH_CAP} — using ${DEFAULT_EMBED_BATCH_CAP}`,
    );

    return DEFAULT_EMBED_BATCH_CAP;
  }

  return parsed;
};

const BATCH_CAP = resolveEmbedBatchCap(process.env.FLUNCLE_EMBED_BATCH);
const QUEUE_LIMIT = 50;
const ADMISSION_OWNER = "fluncle-embed";

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";
const PYTHON_BIN = process.env.PYTHON_BIN ?? "python3";

const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";

const EMBED_SCRIPT =
  process.env.FLUNCLE_EMBED_SCRIPT ?? new URL("embed-track.py", import.meta.url).pathname;

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID ?? "";
const R2_ACCESS_KEY_ID = process.env.FLUNCLE_SOURCE_AUDIO_R2_ACCESS_KEY_ID ?? "";
const R2_SECRET_ACCESS_KEY = process.env.FLUNCLE_SOURCE_AUDIO_R2_SECRET_ACCESS_KEY ?? "";
const R2_BUCKET = process.env.FLUNCLE_SOURCE_AUDIO_R2_BUCKET ?? "fluncle-source-audio";

const log = (message: string) => console.error(`[embed-sweep] ${message}`);

export type QueueFinding = {
  certified?: boolean;

  logId?: null | string;

  sourceAudioKey?: null | string;
  trackId?: string;
};

export type EmbedSource =
  | { key: string; kind: "embed"; trackId: string }
  | { kind: "skip"; reason: "no_source_audio" }
  | { kind: "skip"; reason: "no_track_id" };

type EmbedResult = { embedding: number[]; id: string };
type EmbedError = { error: string; id: string };
type EmbedOutput = { errors?: EmbedError[]; results?: EmbedResult[] };

export function chooseEmbedSource(finding: QueueFinding): EmbedSource {
  if (!finding.trackId) {
    return { kind: "skip", reason: "no_track_id" };
  }

  if (!finding.sourceAudioKey) {
    return { kind: "skip", reason: "no_source_audio" };
  }

  return { key: finding.sourceAudioKey, kind: "embed", trackId: finding.trackId };
}

export function sourceAudioExt(key: string): string {
  const base = key.slice(key.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");

  if (dot <= 0 || dot === base.length - 1) {
    return ".audio";
  }

  return base.slice(dot).toLowerCase();
}

function run(
  bin: string,
  args: string[],
  input?: string,
): { code: number; stderr: string; stdout: string } {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`failed to spawn ${bin}: ${result.error.message}`);
  }

  return {
    code: result.status ?? 1,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

function fluncleJson<T>(args: string[]): T {
  const { code, stderr, stdout } = run(FLUNCLE_BIN, [...args, "--json"]);

  if (code !== 0) {
    throw new Error(`fluncle ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
  }

  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`fluncle ${args.join(" ")} did not return JSON: ${stdout.slice(0, 200)}`);
  }
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
  const stamp = options.now.toISOString().replace(/[:-]|\.\d{3}/g, "");
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
    "",
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

const R2_ENDPOINT =
  process.env.FLUNCLE_SOURCE_AUDIO_R2_ENDPOINT ??
  `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

async function r2Get(key: string): Promise<Uint8Array> {
  const url = `${R2_ENDPOINT}/${R2_BUCKET}/${encodeKey(key)}`;
  const headers = await signS3Request({
    accessKeyId: R2_ACCESS_KEY_ID,
    method: "GET",
    now: new Date(),
    region: "auto",
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    service: "s3",
    url,
  });
  const res = await fetch(url, { headers, method: "GET" });
  if (!res.ok) {
    throw new Error(`R2 GET ${key} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

export type EmbedCapabilities = { updateTrackEmbeddings?: number };

export function parseEmbedQueue(body: unknown): {
  capabilities?: EmbedCapabilities;
  queued?: number;
  tracks: QueueFinding[];
} {
  if (typeof body !== "object" || body === null) {
    return { tracks: [] };
  }

  const page = body as { capabilities?: unknown; queued?: unknown; tracks?: unknown };

  throwIfPageRepairPending("embed queue read", page);
  const tracks = Array.isArray(page.tracks) ? (page.tracks as QueueFinding[]) : [];
  const queued =
    typeof page.queued === "number" && Number.isSafeInteger(page.queued) && page.queued >= 0
      ? page.queued
      : undefined;
  const limit =
    typeof page.capabilities === "object" && page.capabilities !== null
      ? (page.capabilities as EmbedCapabilities).updateTrackEmbeddings
      : undefined;
  const capabilities =
    typeof limit === "number" && Number.isInteger(limit) && limit >= 1
      ? { updateTrackEmbeddings: limit }
      : undefined;

  return {
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(queued === undefined ? {} : { queued }),
    tracks,
  };
}

async function adminApiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "content-type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const text = await failureBodyUnlessRepairPending(res, "embed batched write");

    throw new Error(`embed batched write failed (${res.status}): ${text.slice(0, 200)}`);
  }

  return (await res.json()) as T;
}

async function fetchEmbedQueue(): Promise<{
  capabilities?: EmbedCapabilities;
  queued?: number;
  tracks: QueueFinding[];
}> {
  const url = `${API_BASE_URL}/api/v1/admin/tracks/work?kind=embed&scope=all&limit=${QUEUE_LIMIT}&count=true&debtAware=true`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await failureBodyUnlessRepairPending(res, "embed queue read");
    throw new Error(`embed queue read failed (${res.status}): ${body.slice(0, 200)}`);
  }

  return parseEmbedQueue(await res.json());
}

type EmbedCounts = {
  done: number;
  failed: number;
  fetchFailed: number;
  noSource: number;
  skipped: number;
};

function emptyEmbedCounts(): EmbedCounts {
  return {
    done: 0,
    failed: 0,
    fetchFailed: 0,
    noSource: 0,
    skipped: 0,
  };
}

export const EMBED_SYSTEMIC_STREAK = 3;

export type EmbedFailureClass = "decode" | "engine" | "memory" | "other" | "vector";

export function classifyEmbedFailure(message: string): EmbedFailureClass {
  if (/No module named|ImportError|cannot import name|from_pretrained|torch|muq/i.test(message)) {
    return "engine";
  }

  if (
    /ffmpeg|decoded audio is empty|no embeddable windows|Invalid data|non-zero exit/i.test(message)
  ) {
    return "decode";
  }

  if (/out of memory|Killed|Cannot allocate/i.test(message)) {
    return "memory";
  }

  if (/finite dims/i.test(message)) {
    return "vector";
  }

  return "other";
}

export type EmbedFailureStreak = { class: EmbedFailureClass; count: number };

export type EmbedFailureStreakStore = {
  read(): EmbedFailureStreak | null;
  write(next: EmbedFailureStreak | null): void;
};

export function nextEmbedFailureStreak(options: {
  errors: readonly string[];
  previous: EmbedFailureStreak | null;
  results: number;
}): EmbedFailureStreak | null {
  const attempts = options.results + options.errors.length;

  if (attempts === 0) {
    return options.previous;
  }

  if (options.results > 0 || options.errors.length === 0) {
    return null;
  }

  const classes = new Set(options.errors.map(classifyEmbedFailure));
  const only = [...classes][0];

  if (classes.size !== 1 || only === undefined) {
    return null;
  }

  return {
    class: only,
    count: (options.previous?.class === only ? options.previous.count : 0) + 1,
  };
}

export function embedFailureStreakPath(): string {
  return join(process.env.HOME ?? "/opt/data/home", ".fluncle-embed", "failure-streak");
}

function fileFailureStreakStore(path: string): EmbedFailureStreakStore {
  return {
    read: () => {
      try {
        const [className, count] = readFileSync(path, "utf8").trim().split("\t");
        const parsed = Number.parseInt(count ?? "", 10);

        if (!className || !Number.isFinite(parsed) || parsed <= 0) {
          return null;
        }

        return { class: classifyEmbedFailure(className), count: parsed };
      } catch {
        return null;
      }
    },
    write: (next) => {
      try {
        mkdirSync(dirname(path), { recursive: true });

        if (next === null) {
          rmSync(path, { force: true });

          return;
        }

        writeFileSync(path, `${next.class}\t${next.count}\n`);
      } catch (error) {
        log(
          `failure-streak write failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

export function buildEmbedSummary(options: {
  batchFallout?: number;
  checked: number;
  costWriteFailures?: number;
  counts: EmbedCounts;
  errors: number;
  failureStreak?: EmbedFailureStreak | null;

  itemTiming?: readonly number[];

  leases?: number;
  ok: boolean;
  queued?: number;
  reason?: string;
}): Record<string, unknown> {
  const batchFallout = Math.max(0, options.batchFallout ?? 0);
  const continuedSkipped = Math.max(0, options.counts.skipped - batchFallout);
  const failed =
    options.counts.failed + options.counts.fetchFailed + options.counts.noSource + continuedSkipped;
  const queueDepth =
    options.queued === undefined
      ? {}
      : { queue_depth: Math.max(0, options.queued - options.counts.done) };

  return {
    checked: options.checked,
    ...(options.costWriteFailures === undefined
      ? {}
      : { costWriteFailures: options.costWriteFailures }),
    done: options.counts.done,

    embedFailed: options.counts.failed,
    ...(options.failureStreak == null
      ? {}
      : {
          embedFailureClass: options.failureStreak.class,
          embedFailureStreak: options.failureStreak.count,
        }),
    errors: options.errors,
    failed,
    fetchFailed: options.counts.fetchFailed,
    ...summariseItemTiming(options.itemTiming ?? []),
    ...(options.leases === undefined ? {} : { leases: options.leases }),
    noSource: options.counts.noSource,
    ok: options.ok,
    produced: options.counts.done,
    ...(options.queued === undefined ? {} : { queued: options.queued }),
    ...queueDepth,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    skipped: options.counts.skipped,
  };
}

export function buildEmbedFatalSummary(error?: unknown): Record<string, unknown> {
  const errorMessage =
    error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";

  return {
    checked: null,
    ...(error === undefined ? {} : { error: errorMessage }),
    errors: 1,
    failed: null,
    ok: false,
    produced: null,
    reason: "fatal",
  };
}

export type EmbedQueueWindow =
  | {
      capabilities?: EmbedCapabilities;
      kind: "queue";
      queued?: number;
      tracks: QueueFinding[];
    }
  | { kind: "repair-pending"; message: string };

export type EmbedWriteItem = {
  cost: BoxCostEvent;
  embedding: number[];
  trackId: string;
  vectorPath: string;
};

export type EmbedWriteWindow = { costWriteFailures: number; written: boolean };

export type EmbedWriteBatchWindow = {
  costWriteFailures: number;

  elapsedMs?: number[];
  results: { outcome: "deferred" | "failed" | "updated"; trackId: string }[];
};

export type EmbedDatabaseWindows = {
  readQueue(): Promise<EmbedQueueWindow | undefined>;
  writeResult(item: EmbedWriteItem): Promise<EmbedWriteWindow | undefined>;

  writeResults?(items: readonly EmbedWriteItem[]): Promise<EmbedWriteBatchWindow | undefined>;
};

export async function readEmbedQueueWindow(
  fetchQueue: () => Promise<{ queued?: number; tracks: QueueFinding[] }> = fetchEmbedQueue,
): Promise<EmbedQueueWindow> {
  try {
    const page = await fetchQueue();

    return { kind: "queue", ...page };
  } catch (error) {
    if (!isDueWorkRepairPending(error)) {
      throw error;
    }

    return { kind: "repair-pending", message: error.message };
  }
}

async function writeEmbedResultWindow(item: EmbedWriteItem): Promise<EmbedWriteWindow> {
  let written = false;

  try {
    writeFileSync(item.vectorPath, JSON.stringify(item.embedding));
    fluncleJson(["admin", "tracks", "update", item.trackId, "--embedding-file", item.vectorPath]);
    written = true;
    log(`${item.trackId}: embedded + written`);
  } catch (error) {
    log(
      `${item.trackId}: write-back failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const costWriteFailures = (await emitCost([item.cost])).failed;

  return { costWriteFailures, written };
}

async function writeEmbedResultsWindow(
  items: readonly EmbedWriteItem[],
): Promise<EmbedWriteBatchWindow> {
  let results: EmbedWriteBatchWindow["results"];
  let elapsedMs: number[] = [];

  try {
    const response = await adminApiPost<unknown>("/api/v1/admin/tracks/embeddings", {
      items: items.map((item) => ({ embedding: item.embedding, trackId: item.trackId })),
    });

    results = parseEmbedWriteBatchResults(response, items);
    elapsedMs = parseEmbedWriteBatchTiming(response);
  } catch (error) {
    log(`batched write-back failed: ${error instanceof Error ? error.message : String(error)}`);
    results = items.map((item) => ({ outcome: "failed" as const, trackId: item.trackId }));
  }

  const costWriteFailures = (await emitCost(items.map((item) => item.cost))).failed;

  return { costWriteFailures, elapsedMs, results };
}

export function parseEmbedWriteBatchTiming(response: unknown): number[] {
  const rows =
    typeof response === "object" &&
    response !== null &&
    Array.isArray((response as { results?: unknown }).results)
      ? ((response as { results: unknown[] }).results as { elapsedMs?: unknown }[])
      : [];

  return rows.flatMap((row) =>
    typeof row?.elapsedMs === "number" && Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0
      ? [row.elapsedMs]
      : [],
  );
}

export function summariseItemTiming(
  samples: readonly number[],
): { itemMsMax: number; itemMsP50: number; itemSamples: number } | undefined {
  const sorted = [...samples]
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);

  if (sorted.length === 0) {
    return undefined;
  }

  return {
    itemMsMax: sorted[sorted.length - 1] ?? 0,
    itemMsP50: sorted[Math.floor((sorted.length - 1) / 2)] ?? 0,
    itemSamples: sorted.length,
  };
}

export function parseEmbedWriteBatchResults(
  response: unknown,
  items: readonly { trackId: string }[],
): EmbedWriteBatchWindow["results"] {
  const rows =
    typeof response === "object" &&
    response !== null &&
    Array.isArray((response as { results?: unknown }).results)
      ? ((response as { results: unknown[] }).results as {
          outcome?: unknown;
          trackId?: unknown;
        }[])
      : [];

  return items.map((item, index) => {
    const row = rows[index];
    const outcome = row?.outcome;

    if (row?.trackId !== item.trackId) {
      return { outcome: "failed" as const, trackId: item.trackId };
    }

    return {
      outcome: outcome === "updated" || outcome === "deferred" ? outcome : ("failed" as const),
      trackId: item.trackId,
    };
  });
}

const inheritedLeaseWindows: EmbedDatabaseWindows = {
  readQueue: () => readEmbedQueueWindow(),
  writeResult: (item) => writeEmbedResultWindow(item),
  writeResults: (items) => writeEmbedResultsWindow(items),
};

function argumentValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);

  return index >= 0 ? argv[index + 1] : undefined;
}

function windowCommand(window: "read" | "write" | "write-batch", statePath?: string): string[] {
  return [
    process.execPath,
    import.meta.path,
    "--admission-phase",
    window,
    ...(statePath === undefined ? [] : ["--phase-state", statePath]),
  ];
}

function windowEnvelope(stdout: string, window: string): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`embed ${window} window returned an invalid envelope`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`embed ${window} window returned an invalid envelope`);
  }

  const envelope = parsed as Record<string, unknown>;

  if (envelope.kind === "failed") {
    const message = envelope.error;

    throw new Error(typeof message === "string" ? message : `embed ${window} window failed`);
  }

  return envelope;
}

export function parseQueueWindowEnvelope(stdout: string): EmbedQueueWindow {
  const envelope = windowEnvelope(stdout, "queue");

  if (envelope.kind === "repair-pending") {
    const message = envelope.message;

    return {
      kind: "repair-pending",
      message: typeof message === "string" ? message : "embed queue read deferred",
    };
  }

  if (envelope.kind === "queue") {
    return { kind: "queue", ...parseEmbedQueue(envelope) };
  }

  throw new Error("embed queue window returned an invalid envelope");
}

export function parseWriteWindowEnvelope(stdout: string): EmbedWriteWindow {
  const envelope = windowEnvelope(stdout, "write");
  const failures = envelope.costWriteFailures;
  const written = envelope.written;

  if (
    envelope.kind === "write" &&
    typeof written === "boolean" &&
    typeof failures === "number" &&
    Number.isSafeInteger(failures) &&
    failures >= 0
  ) {
    return { costWriteFailures: failures, written };
  }

  throw new Error("embed write window returned an invalid envelope");
}

export function parseWriteBatchWindowEnvelope(stdout: string): EmbedWriteBatchWindow {
  const envelope = windowEnvelope(stdout, "write-batch");
  const failures = envelope.costWriteFailures;
  const results = envelope.results;

  if (
    envelope.kind !== "write-batch" ||
    typeof failures !== "number" ||
    !Number.isSafeInteger(failures) ||
    failures < 0 ||
    !Array.isArray(results)
  ) {
    throw new Error("embed write-batch window returned an invalid envelope");
  }

  return {
    costWriteFailures: failures,
    elapsedMs: Array.isArray(envelope.elapsedMs)
      ? envelope.elapsedMs.filter(
          (value): value is number =>
            typeof value === "number" && Number.isFinite(value) && value >= 0,
        )
      : [],
    results: results.map((row) => {
      const record = row as { outcome?: unknown; trackId?: unknown };

      if (
        typeof record.trackId !== "string" ||
        (record.outcome !== "deferred" &&
          record.outcome !== "failed" &&
          record.outcome !== "updated")
      ) {
        throw new Error("embed write-batch window returned an invalid envelope");
      }

      return { outcome: record.outcome, trackId: record.trackId };
    }),
  };
}

function admittedWindows(): EmbedDatabaseWindows {
  return {
    readQueue: async () => {
      const phase = runDatabaseAdmissionPhase({
        command: windowCommand("read"),
        owner: ADMISSION_OWNER,
        yieldRetries: 0,
      });

      return phase.kind === "yielded" ? undefined : parseQueueWindowEnvelope(phase.stdout);
    },
    writeResult: async (item) => {
      const statePath = `${item.vectorPath}.window.json`;

      writeFileSync(statePath, JSON.stringify(item), { mode: 0o600 });

      const phase = runDatabaseAdmissionPhase({
        command: windowCommand("write", statePath),
        owner: ADMISSION_OWNER,

        yieldRetries: 0,
      });

      return phase.kind === "yielded" ? undefined : parseWriteWindowEnvelope(phase.stdout);
    },
    writeResults: async (items) => {
      const first = items[0];

      if (first === undefined) {
        return { costWriteFailures: 0, results: [] };
      }

      const statePath = `${first.vectorPath}.batch.json`;

      writeFileSync(statePath, JSON.stringify(items), { mode: 0o600 });

      const phase = runDatabaseAdmissionPhase({
        command: windowCommand("write-batch", statePath),
        owner: ADMISSION_OWNER,

        yieldRetries: 0,
      });

      return phase.kind === "yielded" ? undefined : parseWriteBatchWindowEnvelope(phase.stdout);
    },
  };
}

async function runWindowChild(
  window: string,
  statePath: string | undefined,
): Promise<Record<string, unknown>> {
  try {
    if (window === "read") {
      const queue = await readEmbedQueueWindow();

      return queue;
    }

    if (window === "write" && statePath !== undefined) {
      const item = JSON.parse(readFileSync(statePath, "utf8")) as EmbedWriteItem;
      const write = await writeEmbedResultWindow(item);

      return { kind: "write", ...write };
    }

    if (window === "write-batch" && statePath !== undefined) {
      const items = JSON.parse(readFileSync(statePath, "utf8")) as EmbedWriteItem[];
      const write = await writeEmbedResultsWindow(items);

      return { kind: "write-batch", ...write };
    }

    return { error: "invalid embed admission window invocation", kind: "failed" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), kind: "failed" };
  }
}

export type EmbedManifestEntry = { id: string; path: string };

export type EmbedSweepDependencies = {
  batchCap: number;

  capabilities?: EmbedCapabilities;
  embed: (manifest: EmbedManifestEntry[]) => { code: number; stderr: string; stdout: string };

  failureStreak: EmbedFailureStreakStore;
  fetchSourceAudio: (key: string) => Promise<Uint8Array>;
  windows: EmbedDatabaseWindows;
};

export type EmbedSweepOutcome = { exitCode: 0 | 1; summary: Record<string, unknown> };

export function batchedWrites(deps: EmbedSweepDependencies, itemCount: number): boolean {
  if ((process.env.FLUNCLE_EMBED_WRITE_BATCH ?? "1") === "0") {
    return false;
  }

  const limit = deps.capabilities?.updateTrackEmbeddings;

  return (
    deps.windows.writeResults !== undefined &&
    itemCount > 0 &&
    typeof limit === "number" &&
    itemCount <= limit
  );
}

async function applyEmbedWrites(
  deps: EmbedSweepDependencies,
  writeItems: readonly EmbedWriteItem[],
  counts: EmbedCounts,
  itemTiming: number[],
): Promise<{ costWriteFailures: number; leases: number; writesPending: number }> {
  let costWriteFailures = 0;
  let leases = 0;
  let writesPending = 0;

  if (batchedWrites(deps, writeItems.length)) {
    leases += 1;

    const window = await deps.windows.writeResults?.(writeItems);

    if (window === undefined) {
      log(`write window yielded — ${writeItems.length} result(s) left unapplied`);

      return { costWriteFailures, leases, writesPending: writeItems.length };
    }

    costWriteFailures += window.costWriteFailures;
    itemTiming.push(...(window.elapsedMs ?? []));

    for (const result of window.results) {
      if (result.outcome === "updated") {
        counts.done += 1;
      } else if (result.outcome === "deferred") {
        writesPending += 1;
      } else {
        counts.skipped += 1;
      }
    }

    return { costWriteFailures, leases, writesPending };
  }

  for (const [index, item] of writeItems.entries()) {
    leases += 1;

    const window = await deps.windows.writeResult(item);

    if (window === undefined) {
      writesPending = writeItems.length - index;
      log(`${item.trackId}: write window yielded — ${writesPending} result(s) left unapplied`);
      break;
    }

    costWriteFailures += window.costWriteFailures;

    if (window.written) {
      counts.done += 1;
    } else {
      counts.skipped += 1;
    }
  }

  return { costWriteFailures, leases, writesPending };
}

export async function runEmbedSweep(deps: EmbedSweepDependencies): Promise<EmbedSweepOutcome> {
  let leases = 1;

  const itemTiming: number[] = [];
  const queueWindow = await deps.windows.readQueue();

  if (queueWindow === undefined) {
    return {
      exitCode: 0,
      summary: databaseAdmissionYieldSummary({ checked: 0, failed: 0, queueDepth: null }),
    };
  }

  if (queueWindow.kind === "repair-pending") {
    log(queueWindow.message);

    return {
      exitCode: 0,
      summary: dueWorkRepairPendingSummary({ checked: 0, failed: 0, queueDepth: null }),
    };
  }

  const queued = queueWindow.queued;

  const capable: EmbedSweepDependencies = {
    ...deps,
    ...(queueWindow.capabilities === undefined ? {} : { capabilities: queueWindow.capabilities }),
  };
  const batch = queueWindow.tracks.slice(0, deps.batchCap);
  const counts = emptyEmbedCounts();

  if (batch.length === 0) {
    return {
      exitCode: 0,
      summary: buildEmbedSummary({ checked: 0, counts, errors: 0, leases, ok: true, queued }),
    };
  }

  const workdir = mkdtempSync(join(tmpdir(), "fluncle-embed-"));

  try {
    const manifest: EmbedManifestEntry[] = [];

    for (const finding of batch) {
      const source = chooseEmbedSource(finding);

      if (source.kind === "skip") {
        if (source.reason === "no_track_id") {
          counts.skipped += 1;
        } else {
          counts.noSource += 1;
          log(`${finding.logId ?? "?"}: no source_audio_key — leaving queued`);
        }
        continue;
      }

      const audioPath = join(workdir, `${source.trackId}${sourceAudioExt(source.key)}`);

      try {
        writeFileSync(audioPath, await deps.fetchSourceAudio(source.key));
        manifest.push({ id: source.trackId, path: audioPath });
      } catch (error) {
        counts.fetchFailed += 1;
        log(
          `${source.trackId}: source-audio GET failed for ${source.key}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (manifest.length === 0) {
      return {
        exitCode: 0,
        summary: buildEmbedSummary({
          checked: batch.length,
          counts,
          errors: 0,
          leases,
          ok: true,
          queued,
        }),
      };
    }

    const embedStart = Date.now();
    const embed = deps.embed(manifest);
    const embedSeconds = (Date.now() - embedStart) / 1000;

    if (embed.code !== 0) {
      log(`embed-track exited ${embed.code}: ${embed.stderr.trim().slice(-400)}`);
      counts.skipped += manifest.length;

      return {
        exitCode: 1,
        summary: buildEmbedSummary({
          batchFallout: manifest.length,
          checked: batch.length,
          counts,
          errors: 1,
          leases,
          ok: false,
          queued,
          reason: "embed_failed",
        }),
      };
    }

    let parsed: EmbedOutput;

    try {
      parsed = JSON.parse(embed.stdout) as EmbedOutput;
    } catch {
      log(`embed-track did not return JSON: ${embed.stdout.slice(0, 200)}`);
      counts.skipped += manifest.length;

      return {
        exitCode: 1,
        summary: buildEmbedSummary({
          batchFallout: manifest.length,
          checked: batch.length,
          counts,
          errors: 1,
          leases,
          ok: false,
          queued,
          reason: "embed_bad_output",
        }),
      };
    }

    const results = parsed.results ?? [];
    const perResultSeconds = results.length ? embedSeconds / results.length : 0;
    const writeItems: EmbedWriteItem[] = results.map((result) => ({
      cost: selfSecondsCost({
        occurredAt: new Date().toISOString(),
        seconds: perResultSeconds,
        step: "embed",
        trackId: result.id,
      }),
      embedding: result.embedding,
      trackId: result.id,
      vectorPath: join(workdir, `${result.id}.json`),
    }));
    let costWriteFailures = 0;
    let writesPending = 0;

    const written = await applyEmbedWrites(capable, writeItems, counts, itemTiming);

    costWriteFailures += written.costWriteFailures;
    leases += written.leases;
    writesPending += written.writesPending;

    const failureMessages: string[] = [];

    for (const failure of parsed.errors ?? []) {
      counts.failed += 1;
      failureMessages.push(failure.error);
      log(`${failure.id}: embed error — ${failure.error}`);
    }

    const failureStreak = nextEmbedFailureStreak({
      errors: failureMessages,
      previous: deps.failureStreak.read(),
      results: results.length,
    });

    deps.failureStreak.write(failureStreak);

    if (failureStreak !== null && failureStreak.count >= EMBED_SYSTEMIC_STREAK) {
      log(
        `${failureStreak.count} consecutive ticks failed every attempt with the same '${failureStreak.class}' error — the embedder, not the audio`,
      );

      return {
        exitCode: 1,
        summary: buildEmbedSummary({
          checked: batch.length,
          costWriteFailures,
          counts,
          errors: 1,
          failureStreak,
          itemTiming,
          leases,
          ok: false,
          queued,
          reason: "embed_systemic",
        }),
      };
    }

    const summary = buildEmbedSummary({
      checked: batch.length,
      costWriteFailures,
      counts,
      errors: 0,
      failureStreak,
      itemTiming,
      leases,
      ok: true,
      queued,
    });

    if (writesPending > 0) {
      return {
        exitCode: 0,
        summary: { ...databaseAdmissionYieldSummary(summary), partial: true, writesPending },
      };
    }

    return { exitCode: 0, summary };
  } finally {
    rmSync(workdir, { force: true, recursive: true });
  }
}

async function main(): Promise<EmbedSweepOutcome> {
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    return {
      exitCode: 1,
      summary: buildEmbedSummary({
        checked: 0,
        counts: emptyEmbedCounts(),
        errors: 1,
        ok: false,
        reason: "missing_r2_credentials",
      }),
    };
  }

  if (!API_TOKEN) {
    return {
      exitCode: 1,
      summary: buildEmbedSummary({
        checked: 0,
        counts: emptyEmbedCounts(),
        errors: 1,
        ok: false,
        reason: "missing_api_token",
      }),
    };
  }

  return runEmbedSweep({
    batchCap: BATCH_CAP,
    embed: (manifest) => run(PYTHON_BIN, [EMBED_SCRIPT], JSON.stringify(manifest)),
    failureStreak: fileFailureStreakStore(embedFailureStreakPath()),
    fetchSourceAudio: r2Get,

    windows: process.env.FLUNCLE_ADMISSION_RUNNER_PID ? inheritedLeaseWindows : admittedWindows(),
  });
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const admissionWindow = argumentValue(argv, "--admission-phase");

  if (admissionWindow === undefined) {
    main()
      .then(({ exitCode, summary }) => {
        console.log(JSON.stringify(summary));
        process.exitCode = exitCode;
      })
      .catch((error: unknown) => {
        console.error(
          `[embed-sweep] fatal: ${error instanceof Error ? error.message : String(error)}`,
        );
        console.log(JSON.stringify(buildEmbedFatalSummary(error)));
        process.exitCode = 1;
      });
  } else {
    runWindowChild(admissionWindow, argumentValue(argv, "--phase-state"))
      .then((envelope) => {
        console.log(JSON.stringify(envelope));
      })
      .catch((error: unknown) => {
        console.log(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            kind: "failed",
          }),
        );
      });
  }
}
