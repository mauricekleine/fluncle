#!/usr/bin/env bun
// embed-sweep.ts — the bun orchestrator behind the audio-embedding sweep (`fluncle-embed`),
// scheduled by a rave-02 HOST systemd timer (../embed-timer/), not a Hermes gateway cron: a
// windowed full-song MuQ forward is minutes-scale and must not occupy the shared serial
// gateway runner (its ~300s global budget would starve the latency-sensitive 5-min sweeps —
// the same reason capture is a host timer). See ../embed-timer/README.md + docs/track-lifecycle.md.
//
// LIVE-INTENT. Version-controlled source; the repo is canonical and the box is a deploy
// target (fluncle-hermes-operator skill). Invoked by the bash wrapper (embed-sweep.sh) the
// host timer `docker exec`s on a schedule — see that file's header for the wire-up.
//
// This is the on-box embedding path: it embeds ON the box (torch + MuQ, via embed-track.py),
// so there is no Worker-side trigger. Pure compute, zero LLM tokens. It writes the vector
// back through the agent-tier `update_track` path (the box's admin token), exactly like
// enrich-sweep writes bpm/key/features.
//
// SOURCE = the CAPTURED FULL SONG, not the 30s preview. The embed queue gates server-side on a
// captured `source_audio_key`, `has_embedding = 0`, and a capture not quarantined as wrong audio,
// so a queued track always has a captured full song in the PRIVATE `fluncle-source-audio` R2
// bucket. We deliberately do NOT embed previews (the blind "quiet piano" vectors are the thing
// this whole effort kills), so a track with no `sourceAudioKey` is skipped, never
// preview-fetched. The S3 GET mirrors capture-sweep.ts's signer (which mirrors
// apps/web/src/lib/server/aws-sigv4.ts) — keep them in step.
//
// THE QUEUE IS CATALOGUE-AWARE (docs/gpu-batch-embed.md). It reads `list_track_work`, NOT the
// old `admin tracks embed --queue`: that one went through `list_tracks_admin`, which drives
// through the FINDING JOIN, so it was structurally blind to a CATALOGUE track (a `tracks` row
// with no `findings` row). A catalogue track could therefore never be embedded — and The Ear
// ranks the catalogue BY its embedding, so the feature had nothing to rank. Embedding is a
// measurement of a RECORDING; it applies to any track with captured audio, certified or not.
//
// The read is DIRECT HTTP rather than the baked CLI, deliberately: the box's `fluncle` binary
// is a PINNED release, so a queue read through a NEW CLI command would need a pin bump before
// this sweep could run. The WRITE-BACK stays on the CLI (`tracks update --embedding-file` is an
// existing command, unchanged), so this sweep ships without touching the pin. Same trick
// capture-sweep.ts already uses for its queue read.
//
// DATABASE ADMISSION IS PHASE-SCOPED (docs/database-performance.md). The host unit starts this
// sweep directly, and only its database windows hold the single background-writer lease:
//
//   1. [admitted window] GET /api/v1/admin/tracks/work?kind=embed → the worklist, in drain order.
//      The guarded due-work read can advance a bounded repair step, so it is a write-class window.
//   2. [no lease] S3-GET each track's captured full song (`sourceAudioKey`) → a temp file.
//   3. [no lease] ONE `python3 embed-track.py` call over the batch → {results, errors}
//      (the MuQ model load is amortized; embed-track.py WINDOWS the long audio to bound RAM).
//   4. [one admitted window per result] `fluncle admin tracks update <trackId> --embedding-file
//      <tmp>`, then that result's self-seconds cost row. NO `--status` is ever passed:
//      `enrichment_status` is a CERTIFICATION column, and the server 409s an uncertified write
//      of one (the certification rail, track-update.ts).
//
// NO MUTATION IS REPLAYED. `track.embed` is deliberately non-replayable: every accepted vector
// write mints a fresh catalogue-rank material revision and appends a Sonar artifact change, so
// repeating a write is never a no-op. A write window issues its update exactly once. An update
// whose CLI call fails, including a transport failure whose outcome is unknown, is counted and
// never re-issued in the tick. A window that yields (exit 75, whether its command never started
// or was fenced mid-flight) stops the run as paused backpressure and reports every unapplied
// result as `writesPending`. The durable fence is the next tick's admitted worklist read: a
// landed write sets `has_embedding = 1` and removes the track, while an unlanded one stays queued.
//
// An inherited whole-lifetime runner (`FLUNCLE_ADMISSION_RUNNER_PID`, exported by an installed
// unit that still wraps this script in database-admission-runner.sh) already holds the lease for
// the whole process, so the same windows then run in-process without nesting phase admission.
//
// `runEmbedSweep` takes its database windows, source fetch, and embedder as dependencies and is
// unit-tested with fakes in embed-sweep.test.ts, alongside the pure helpers. `main()` is guarded
// behind `import.meta.main` so importing this module for the tests is side-effect free (it does
// not read R2 or spawn the embedder).
//
// stdout: one JSON summary line (the run output the /status prober reads); a database window
// child prints one JSON envelope instead. Diagnostics → stderr.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BoxCostEvent, emitCost, selfSecondsCost } from "./cost-emit";
import {
  databaseAdmissionYieldSummary,
  runDatabaseAdmissionPhase,
} from "./database-admission-phase";
import {
  dueWorkRepairPendingSummary,
  failureBodyUnlessRepairPending,
  isDueWorkRepairPending,
} from "./due-work-repair-pending";

// ---------------------------------------------------------------------------
// Config — the batch cap is how many tracks one tick embeds. A windowed full-song MuQ forward
// is minutes-scale (each ~30s window is a full forward, and a 5-min song is ~10 windows), so
// the cap is what bounds the tick's wall-clock. As a host timer the 120s/300s gateway kill no
// longer applies, but the queue is still the durable worklist — anything not reached this tick
// is picked up ~5m later, in drain order.
//
// WHY A BATCH BEATS ITS OWN ITEM COUNT: the manifest goes to ONE `embed-track.py` process, so
// the multi-second torch import + MuQ model load is paid once for the whole batch instead of
// once per track, and the tick pays ONE admitted worklist window instead of one per track.
// Only the per-result write windows still scale with the batch.
//
// THE CAP AND THE UNIT'S `TimeoutStartSec` ARE ONE DECISION. Each result's write window can
// wait up to the runner's 120s admission ceiling, so a raised cap must re-derive that timeout;
// the arithmetic lives beside it in ../embed-timer/fluncle-embed.service. `MAX_EMBED_BATCH_CAP`
// is the typo guard on the env knob, not a licence — a value above the default still needs the
// unit's timeout re-derived before it is set.
// ---------------------------------------------------------------------------

export const DEFAULT_EMBED_BATCH_CAP = 3;
export const MAX_EMBED_BATCH_CAP = 6;

/**
 * `FLUNCLE_EMBED_BATCH` — tracks embedded per tick. Absent or empty takes the default; a value
 * that is not an integer within 1..MAX_EMBED_BATCH_CAP is refused loudly and the default stands,
 * so a fat-fingered unit env can never hand the sweep an unbounded or zero-width batch.
 */
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
const QUEUE_LIMIT = 50; // hard ceiling on the queue read (we only act on BATCH_CAP)
const ADMISSION_OWNER = "fluncle-embed";

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";
const PYTHON_BIN = process.env.PYTHON_BIN ?? "python3";

// The queue read goes over direct HTTP (see the header): the box CLI is a PINNED release, so
// a new command would gate this sweep behind a pin bump. The write-back still uses the CLI.
const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";
// The MuQ inference script — baked beside this orchestrator (/opt/hermes-scripts/).
const EMBED_SCRIPT =
  process.env.FLUNCLE_EMBED_SCRIPT ?? new URL("embed-track.py", import.meta.url).pathname;

// A dedicated, least-privilege R2 token: Object Read on the PRIVATE fluncle-source-audio
// bucket (the same credential capture writes with; never fluncle-videos, which is world-served).
// Read from env (the shared ~/.fluncle-secrets.env supplies them on the box), never hardcoded.
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID ?? "";
const R2_ACCESS_KEY_ID = process.env.FLUNCLE_SOURCE_AUDIO_R2_ACCESS_KEY_ID ?? "";
const R2_SECRET_ACCESS_KEY = process.env.FLUNCLE_SOURCE_AUDIO_R2_SECRET_ACCESS_KEY ?? "";
const R2_BUCKET = process.env.FLUNCLE_SOURCE_AUDIO_R2_BUCKET ?? "fluncle-source-audio";

const log = (message: string) => console.error(`[embed-sweep] ${message}`);

// ---------------------------------------------------------------------------
// Types — only the fields we consume from each surface.
// ---------------------------------------------------------------------------

export type QueueFinding = {
  // True when a `findings` row exists. FALSE for a catalogue track — and the sweep must then
  // never write a certification field back (no `--status`); the server would 409 it anyway
  // (the certification rail), but the sweep does not even try.
  certified?: boolean;
  // Null for a catalogue track: the coordinate lives on the certification.
  logId?: null | string;
  // The R2 key for the captured full song, surfaced on the work-queue DTO. PRESENCE means
  // captured; the queue is key-gated, so this is populated for every real row — but we still
  // skip defensively when it is absent (never fall back to the preview).
  sourceAudioKey?: null | string;
  trackId?: string;
};

// The per-finding source decision: embed it (we have a trackId + a captured key), or skip it
// with a reason (logged, left queued). A discriminated union so the caller can't forget a case.
export type EmbedSource =
  | { key: string; kind: "embed"; trackId: string }
  | { kind: "skip"; reason: "no_source_audio" }
  | { kind: "skip"; reason: "no_track_id" };

type EmbedResult = { embedding: number[]; id: string };
type EmbedError = { error: string; id: string };
type EmbedOutput = { errors?: EmbedError[]; results?: EmbedResult[] };

// ---------------------------------------------------------------------------
// Pure helpers (exported for embed-sweep.test.ts).
// ---------------------------------------------------------------------------

/**
 * Decide what to do with a queued finding: embed it (has both a trackId and a captured
 * `sourceAudioKey`) or skip it with a reason. We NEVER fall back to the preview relay — the
 * preview vectors are exactly what this switch to full audio kills. The queue is key-gated
 * upstream, so `no_source_audio` is a defensive skip, not the normal path.
 */
export function chooseEmbedSource(finding: QueueFinding): EmbedSource {
  if (!finding.trackId) {
    return { kind: "skip", reason: "no_track_id" };
  }

  if (!finding.sourceAudioKey) {
    return { kind: "skip", reason: "no_source_audio" };
  }

  return { key: finding.sourceAudioKey, kind: "embed", trackId: finding.trackId };
}

/**
 * The file extension (with leading dot, lowercased) of a source-audio key so the temp file
 * carries the captured container's suffix (`<logId>/<sha256>.webm` → `.webm`). ffmpeg decodes
 * by content, so this is hygiene rather than load-bearing; a key with no extension falls back
 * to `.audio`.
 */
export function sourceAudioExt(key: string): string {
  const base = key.slice(key.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");

  if (dot <= 0 || dot === base.length - 1) {
    return ".audio";
  }

  return base.slice(dot).toLowerCase();
}

// ---------------------------------------------------------------------------
// Shell helpers — synchronous, fail-loud where it matters.
// ---------------------------------------------------------------------------

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

// ── MIRROR of apps/web/src/lib/server/aws-sigv4.ts (via capture-sweep.ts) — keep in step ──

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

// ── R2 (S3 API) get ──────────────────────────────────────────────────────────
// The GET counterpart to capture-sweep.ts's r2Put: same signer, no body → the empty-payload
// hash, and the response bytes are the captured full song.

// The account S3 endpoint. FLUNCLE_SOURCE_AUDIO_R2_ENDPOINT points the same signed GET at a
// loopback fixture under test; production leaves it unset.
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

// ── The work queue (direct HTTP — pin-independent, not the baked CLI) ────────
//
// `kind=embed` is "captured audio on file, no MuQ vector yet", over `tracks` rather than
// `findings` — so it covers a CATALOGUE track exactly as it covers a finding. `scope=all`
// with the server's drain order (certified first, then the Ear's capture-priority ladder)
// means the catalogue can never starve the findings' backlog.

export function parseEmbedQueue(body: unknown): {
  queued?: number;
  tracks: QueueFinding[];
} {
  if (typeof body !== "object" || body === null) {
    return { tracks: [] };
  }

  const page = body as { queued?: unknown; tracks?: unknown };
  const tracks = Array.isArray(page.tracks) ? (page.tracks as QueueFinding[]) : [];
  const queued =
    typeof page.queued === "number" && Number.isSafeInteger(page.queued) && page.queued >= 0
      ? page.queued
      : undefined;

  return queued === undefined ? { tracks } : { queued, tracks };
}

async function fetchEmbedQueue(): Promise<{ queued?: number; tracks: QueueFinding[] }> {
  const url = `${API_BASE_URL}/api/v1/admin/tracks/work?kind=embed&scope=all&limit=${QUEUE_LIMIT}&count=true`;
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

export function buildEmbedSummary(options: {
  batchFallout?: number;
  checked: number;
  costWriteFailures?: number;
  counts: EmbedCounts;
  errors: number;
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
    // `failed` used to mean only embedder-reported item failures. Keep that split explicitly
    // while the canonical counter covers every item failure the run continued past.
    embedFailed: options.counts.failed,
    errors: options.errors,
    failed,
    fetchFailed: options.counts.fetchFailed,
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

// ---------------------------------------------------------------------------
// Database windows — the only work that holds database admission.
// ---------------------------------------------------------------------------

/** The worklist window's answer. The typed due-work deferral is data, never a failed window. */
export type EmbedQueueWindow =
  | { kind: "queue"; queued?: number; tracks: QueueFinding[] }
  | { kind: "repair-pending"; message: string };

/** One vector write and the self-seconds cost row its compute earned. */
export type EmbedWriteItem = {
  cost: BoxCostEvent;
  embedding: number[];
  trackId: string;
  vectorPath: string;
};

/** A completed write window: whether the update landed, and how many cost rows were rejected. */
export type EmbedWriteWindow = { costWriteFailures: number; written: boolean };

/**
 * Where the database work runs. Each method resolves `undefined` when its admission window
 * yielded: a yielded read proved nothing, and a yielded write is unproven and never re-issued.
 */
export type EmbedDatabaseWindows = {
  readQueue(): Promise<EmbedQueueWindow | undefined>;
  writeResult(item: EmbedWriteItem): Promise<EmbedWriteWindow | undefined>;
};

/** The worklist window body. */
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

/**
 * The write window body. The update runs exactly once; a failure, whose outcome may be unknown,
 * is reported and never retried. The self-seconds row is recorded whether or not the update
 * landed, because the embed compute was spent either way.
 */
async function writeEmbedResultWindow(item: EmbedWriteItem): Promise<EmbedWriteWindow> {
  let written = false;

  try {
    // A file arg: a 1024-float array is large for an inline flag.
    writeFileSync(item.vectorPath, JSON.stringify(item.embedding));
    fluncleJson(["admin", "tracks", "update", item.trackId, "--embedding-file", item.vectorPath]);
    written = true;
    log(`${item.trackId}: embedded + written`);
  } catch (error) {
    log(
      `${item.trackId}: write-back failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Best-effort ledger row: a failure cannot kill the sweep, but its count reaches the summary.
  const costWriteFailures = (await emitCost([item.cost])).failed;

  return { costWriteFailures, written };
}

/** An inherited whole-lifetime lease already covers this process, so windows run in-process. */
const inheritedLeaseWindows: EmbedDatabaseWindows = {
  readQueue: () => readEmbedQueueWindow(),
  writeResult: (item) => writeEmbedResultWindow(item),
};

function argumentValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);

  return index >= 0 ? argv[index + 1] : undefined;
}

function windowCommand(window: "read" | "write", statePath?: string): string[] {
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
    // The child's own error travels as data, so the run's fatal summary keeps its message.
    const message = envelope.error;

    throw new Error(typeof message === "string" ? message : `embed ${window} window failed`);
  }

  return envelope;
}

/** Parse a completed worklist window's stdout envelope. */
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

/** Parse a completed write window's stdout envelope. */
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

/** Every database window is its own admission phase; nothing between windows holds the lease. */
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
        // track.embed is deliberately non-replayable in DATABASE_MUTATION_POLICIES.
        yieldRetries: 0,
      });

      return phase.kind === "yielded" ? undefined : parseWriteWindowEnvelope(phase.stdout);
    },
  };
}

/** One database window child. It never throws; it prints exactly one envelope. */
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

    return { error: "invalid embed admission window invocation", kind: "failed" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), kind: "failed" };
  }
}

// ---------------------------------------------------------------------------
// The sweep — drain a bounded batch off the queue.
// ---------------------------------------------------------------------------

export type EmbedManifestEntry = { id: string; path: string };

export type EmbedSweepDependencies = {
  batchCap: number;
  embed: (manifest: EmbedManifestEntry[]) => { code: number; stderr: string; stdout: string };
  fetchSourceAudio: (key: string) => Promise<Uint8Array>;
  windows: EmbedDatabaseWindows;
};

export type EmbedSweepOutcome = { exitCode: 0 | 1; summary: Record<string, unknown> };

export async function runEmbedSweep(deps: EmbedSweepDependencies): Promise<EmbedSweepOutcome> {
  const queueWindow = await deps.windows.readQueue();

  if (queueWindow === undefined) {
    // The worklist window yielded before proving a read, so the tick pauses and the next reads.
    return {
      exitCode: 0,
      summary: databaseAdmissionYieldSummary({ checked: 0, failed: 0, queueDepth: null }),
    };
  }

  if (queueWindow.kind === "repair-pending") {
    // The Worker deferred the queue read while due-work repair converges: nothing was read, so the
    // tick pauses cleanly and the next tick reads again.
    log(queueWindow.message);

    return {
      exitCode: 0,
      summary: dueWorkRepairPendingSummary({ checked: 0, failed: 0, queueDepth: null }),
    };
  }

  const queued = queueWindow.queued;
  const batch = queueWindow.tracks.slice(0, deps.batchCap);
  const counts = emptyEmbedCounts();

  if (batch.length === 0) {
    // Fast no-op.
    return {
      exitCode: 0,
      summary: buildEmbedSummary({ checked: 0, counts, errors: 0, ok: true, queued }),
    };
  }

  const workdir = mkdtempSync(join(tmpdir(), "fluncle-embed-"));

  try {
    // (1) No lease: S3-GET each finding's captured full song and build the MuQ manifest. The
    // queue payload already carries the canonical trackId + the captured `sourceAudioKey`, so
    // no re-read is needed. We GET the full key string as stored (never rebuild it).
    const manifest: EmbedManifestEntry[] = [];

    for (const finding of batch) {
      const source = chooseEmbedSource(finding);

      if (source.kind === "skip") {
        if (source.reason === "no_track_id") {
          counts.skipped += 1;
        } else {
          // The queue is key-gated upstream, so this is defensive: a finding with no captured
          // full song is left queued (capture may land it later). We deliberately never embed
          // the 30s preview as a fallback.
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
        // A transient R2 error (or a key whose object went missing) — leave it queued; a later
        // tick retries. Never a fallback to the preview.
        counts.fetchFailed += 1;
        log(
          `${source.trackId}: source-audio GET failed for ${source.key}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (manifest.length === 0) {
      return {
        exitCode: 0,
        summary: buildEmbedSummary({ checked: batch.length, counts, errors: 0, ok: true, queued }),
      };
    }

    // (2) No lease: ONE python call over the batch — the MuQ model load is amortized.
    // embed-track.py windows the long audio and mean-pools across windows to bound peak RAM.
    // Time it for the self-seconds cost row: the model-load is shared, so the wall-time is split
    // evenly across the findings it embedded, so a batch's shared load is never billed twice.
    const embedStart = Date.now();
    const embed = deps.embed(manifest);
    const embedSeconds = (Date.now() - embedStart) / 1000;

    if (embed.code !== 0) {
      // A batch-level failure (torch import / model load): leave everything queued.
      log(`embed-track exited ${embed.code}: ${embed.stderr.trim().slice(-400)}`);
      counts.skipped += manifest.length;

      return {
        exitCode: 1,
        summary: buildEmbedSummary({
          batchFallout: manifest.length,
          checked: batch.length,
          counts,
          errors: 1,
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
          ok: false,
          queued,
          reason: "embed_bad_output",
        }),
      };
    }

    // (3) One admitted window per result: its vector write and its even share of the batch
    // wall-time as a self-seconds cost row.
    const results = parsed.results ?? [];
    const perResultSeconds = results.length ? embedSeconds / results.length : 0;
    let costWriteFailures = 0;
    let writesPending = 0;

    for (const [index, result] of results.entries()) {
      const window = await deps.windows.writeResult({
        cost: selfSecondsCost({
          occurredAt: new Date().toISOString(),
          seconds: perResultSeconds,
          step: "embed",
          trackId: result.id,
        }),
        embedding: result.embedding,
        trackId: result.id,
        vectorPath: join(workdir, `${result.id}.json`),
      });

      if (window === undefined) {
        // The yielded write is unproven: it is never re-issued, and no later write starts.
        writesPending = results.length - index;
        log(`${result.id}: write window yielded — ${writesPending} result(s) left unapplied`);
        break;
      }

      costWriteFailures += window.costWriteFailures;

      if (window.written) {
        counts.done += 1;
      } else {
        counts.skipped += 1;
      }
    }

    for (const failure of parsed.errors ?? []) {
      counts.failed += 1;
      log(`${failure.id}: embed error — ${failure.error}`);
    }

    const summary = buildEmbedSummary({
      checked: batch.length,
      costWriteFailures,
      counts,
      errors: 0,
      ok: true,
      queued,
    });

    if (writesPending > 0) {
      // Designed backpressure: the measured counts stay real and the unapplied results are named.
      return {
        exitCode: 0,
        summary: { ...databaseAdmissionYieldSummary(summary), partial: true, writesPending },
      };
    }

    return { exitCode: 0, summary };
  } finally {
    // Temp files (the captured audio, the vector JSON, window state) are removed regardless.
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
    fetchSourceAudio: r2Get,
    // An installed unit that still wraps this script already owns a whole-lifetime lease. Nesting
    // phase admission under it would wait on itself, so only that inherited runner context keeps
    // the in-process windows.
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
    // A database window child: its one stdout line is the envelope the parent parses.
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
