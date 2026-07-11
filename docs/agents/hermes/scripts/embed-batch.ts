#!/usr/bin/env bun
// embed-batch.ts — the GPU BATCH embed path (docs/gpu-batch-embed.md).
//
// The on-box sweep (embed-sweep.ts) embeds ONE track per 5-minute tick on rave-02, which is
// CPU-only: a windowed full-song MuQ forward is minutes-scale there, so the box does roughly
// a dozen tracks a day. That is fine for the certified archive — Fluncle finds ~15 tracks a
// WEEK — and hopeless for the catalogue, which the crawler will land in the thousands. At a
// dozen a day, a 10k catalogue is two years, and The Ear ranks by embedding, so a catalogue
// track with no vector is a track The Ear cannot hear at all.
//
// So this is the other shape of the same job: take N tracks off the SAME queue, pull their
// audio, embed them in ONE GPU pass, and write the vectors back through the SAME agent-tier
// API. It is not a cron — it is an OPERATOR-FIRED batch on a rented GPU (RunPod), because the
// pod costs money by the minute and nothing here should be able to start one on its own.
//
// ── WHAT MAKES THE TWO PATHS ONE PIPELINE ────────────────────────────────────────────────
// The inference is the SAME script (embed-track.py) with two env knobs — `MUQ_DEVICE=cuda` and
// a wider `MUQ_WINDOW_BATCH`. That is deliberate and it is the load-bearing decision here: the
// decode → window → mean-pool → L2-normalize pipeline IS the embedding contract, and a second
// implementation of it "for the GPU" is how you end up with two vectors of the same track that
// no longer sit in the same space. Same script, same windows, same pooling — only the device
// and the number of kernel launches differ. A CPU-embedded finding and a GPU-embedded
// catalogue track are directly comparable, which is the entire point of The Ear.
//
// ── THE BOUNDARY ─────────────────────────────────────────────────────────────────────────
// This is the CONSUMER side: given audio ALREADY in the private R2 bucket, embed it. How the
// bytes got there (the acquisition) is a separate concern with its own metered budget, and it
// is not this script's business. This one reads, embeds, and writes back — nothing else.
//
//   1. GET /api/admin/tracks/work?kind=embed  → the worklist, in the server's drain order
//      (certified first, then the Ear's capture-priority ladder). Catalogue-aware.
//   2. S3-GET each track's captured full song from the PRIVATE bucket, CONCURRENTLY (the pod
//      is remote from R2, so the download is latency-bound and would otherwise dominate).
//   3. ONE `embed-track.py` call over the whole manifest — the multi-second model load is paid
//      once for the entire batch instead of once per track.
//   4. PATCH each vector back via the agent-tier `update_track`. The WORKER is the publish
//      boundary; this pod never touches the database.
//
// NO fluncle CLI. A rented pod is a bare container, and the box's CLI is a pinned release
// baked into a different image — so every API call here is direct HTTP with the agent token,
// exactly as capture-sweep.ts already does for its queue read.
//
// RESUMABLE BY CONSTRUCTION. An embedded track leaves the `embedding_json IS NULL` queue, so
// re-running after a crash (or a pod that got reclaimed) simply picks up what is left. Nothing
// is checkpointed because nothing needs to be.
//
// Usage (on the pod — see docs/gpu-batch-embed.md for the full runbook):
//   bun embed-batch.ts --limit 200
//   bun embed-batch.ts --limit 200 --scope catalogue --dry-run
//
// stdout: one JSON summary line. Diagnostics → stderr.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";

const PYTHON_BIN = process.env.PYTHON_BIN ?? "python3";
const EMBED_SCRIPT =
  process.env.FLUNCLE_EMBED_SCRIPT ?? new URL("embed-track.py", import.meta.url).pathname;

// The PRIVATE source-audio bucket. Read-only is all this needs — it never writes an object.
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID ?? "";
const R2_ACCESS_KEY_ID = process.env.FLUNCLE_SOURCE_AUDIO_R2_ACCESS_KEY_ID ?? "";
const R2_SECRET_ACCESS_KEY = process.env.FLUNCLE_SOURCE_AUDIO_R2_SECRET_ACCESS_KEY ?? "";
const R2_BUCKET = process.env.FLUNCLE_SOURCE_AUDIO_R2_BUCKET ?? "fluncle-source-audio";
const R2_ENDPOINT = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

/** How many R2 GETs are in flight at once. The pod is remote from R2; serial downloads would
 *  dominate the wall-clock and leave the (expensive) GPU idle waiting for bytes. */
const DOWNLOAD_CONCURRENCY = Number(process.env.FLUNCLE_EMBED_DOWNLOAD_CONCURRENCY ?? "6");

/** The server's own ceiling on one worklist read. */
const MAX_QUEUE_LIMIT = 200;

const log = (message: string) => console.error(`[embed-batch] ${message}`);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkItem = {
  artists?: string[];
  certified?: boolean;
  logId?: null | string;
  sourceAudioKey?: null | string;
  title?: string;
  trackId?: string;
};

type EmbedResult = { embedding: number[]; id: string };
type EmbedError = { error: string; id: string };
type EmbedOutput = { errors?: EmbedError[]; results?: EmbedResult[] };

export type BatchArgs = {
  dryRun: boolean;
  limit: number;
  scope: "all" | "catalogue" | "findings";
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for embed-batch.test.ts)
// ---------------------------------------------------------------------------

/**
 * Parse the pod's argv. Everything has a safe default, and `--limit` is clamped to the
 * server's own ceiling so a fat-fingered `--limit 100000` cannot ask for a page the API
 * would refuse (and cannot rent GPU time downloading an archive nobody asked for).
 */
export function parseBatchArgs(argv: string[]): BatchArgs {
  const args: BatchArgs = { dryRun: false, limit: 50, scope: "all" };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--limit") {
      const value = Number(argv[index + 1]);

      if (Number.isFinite(value) && value > 0) {
        args.limit = Math.min(Math.trunc(value), MAX_QUEUE_LIMIT);
      }

      index += 1;
    } else if (arg === "--scope") {
      const value = argv[index + 1];

      if (value === "all" || value === "catalogue" || value === "findings") {
        args.scope = value;
      }

      index += 1;
    }
  }

  return args;
}

/**
 * The file extension of a source-audio key, so the temp file carries the captured container's
 * suffix. ffmpeg decodes by content, so this is hygiene rather than load-bearing.
 */
export function sourceAudioExt(key: string): string {
  const base = key.slice(key.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");

  if (dot <= 0 || dot === base.length - 1) {
    return ".audio";
  }

  return base.slice(dot).toLowerCase();
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight, preserving nothing about
 * order (the manifest is keyed by trackId, not by position). A worker that throws yields
 * `null` — one dead object in R2 must never sink the batch, and the track simply stays queued.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<Array<null | R>> {
  const results: Array<null | R> = Array.from({ length: items.length }, () => null);
  const width = Math.max(1, Math.trunc(concurrency));
  let next = 0;

  async function pump(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;

      if (index >= items.length) {
        return;
      }

      const item = items[index];

      if (item === undefined) {
        continue;
      }

      try {
        results[index] = await worker(item);
      } catch {
        results[index] = null;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(width, items.length) }, () => pump()));

  return results;
}

// ---------------------------------------------------------------------------
// AWS SigV4 — MIRROR of apps/web/src/lib/server/aws-sigv4.ts (via embed-sweep.ts).
// Box/pod scripts cannot import the workspace, so the self-contained copy is the norm.
// ---------------------------------------------------------------------------

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

async function signS3Get(url: string): Promise<Record<string, string>> {
  const parsed = new URL(url);
  const now = new Date();
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = stamp.slice(0, 8);
  const payloadHash = await sha256Hex(new Uint8Array());
  const headers: Record<string, string> = {
    host: parsed.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": stamp,
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    "GET",
    canonicalUri(parsed.pathname),
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, await sha256Hex(canonicalRequest)].join(
    "\n",
  );

  let signingKey: ArrayBuffer | Uint8Array = encoder.encode(`AWS4${R2_SECRET_ACCESS_KEY}`);

  for (const part of [dateStamp, "auto", "s3", "aws4_request"]) {
    signingKey = await hmac(signingKey, part);
  }

  const signature = toHex(await hmac(signingKey, stringToSign));
  const { host: _host, ...sent } = headers;

  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

/** GET the captured full song from the PRIVATE bucket. The key is used AS STORED, never rebuilt. */
async function r2Get(key: string): Promise<Uint8Array> {
  const url = `${R2_ENDPOINT}/${R2_BUCKET}/${encodeKey(key)}`;
  const res = await fetch(url, { headers: await signS3Get(url), method: "GET" });

  if (!res.ok) {
    throw new Error(`R2 GET ${key} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  return new Uint8Array(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// The agent-tier API (direct HTTP — the Worker is the publish boundary)
// ---------------------------------------------------------------------------

async function fetchEmbedQueue(args: BatchArgs): Promise<WorkItem[]> {
  const url = `${API_BASE_URL}/api/admin/tracks/work?kind=embed&scope=${args.scope}&limit=${args.limit}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`embed queue read failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  const body = (await res.json()) as { tracks?: WorkItem[] };

  return Array.isArray(body.tracks) ? body.tracks : [];
}

/**
 * Write ONE vector back through the agent-tier `update_track`. NOTHING ELSE is sent: no status,
 * no note, no coordinate. `embedding` is a `tracks` column, so this is legal on a catalogue
 * track — and the certification fields are not, which the server enforces (a 409 `uncertified`).
 * The pod holds an agent token and never speaks to the database.
 */
async function writeEmbedding(trackId: string, embedding: number[]): Promise<void> {
  const url = `${API_BASE_URL}/api/admin/tracks/${encodeURIComponent(trackId)}`;
  const res = await fetch(url, {
    body: JSON.stringify({ embedding }),
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "content-type": "application/json",
    },
    method: "PATCH",
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    throw new Error(
      `update_track ${trackId} failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseBatchArgs(process.argv.slice(2));

  if (!API_TOKEN) {
    console.log(JSON.stringify({ ok: false, reason: "missing_api_token" }));
    process.exitCode = 1;

    return;
  }

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    console.log(JSON.stringify({ ok: false, reason: "missing_r2_credentials" }));
    process.exitCode = 1;

    return;
  }

  const queue = await fetchEmbedQueue(args);
  const summary = {
    catalogue: 0,
    done: 0,
    downloaded: 0,
    failed: 0,
    findings: 0,
    queued: queue.length,
    scope: args.scope,
    writeFailed: 0,
  };

  if (queue.length === 0) {
    console.log(JSON.stringify({ ok: true, ...summary }));

    return;
  }

  for (const item of queue) {
    if (item.certified) {
      summary.findings += 1;
    } else {
      summary.catalogue += 1;
    }
  }

  if (args.dryRun) {
    // The pod costs money by the minute, so "what would this batch do" must be answerable
    // WITHOUT starting the GPU — and without pulling a single (billed) byte out of R2.
    log(`dry run — ${queue.length} track(s) would be embedded`);

    for (const item of queue) {
      log(
        `  ${item.logId ?? `${item.trackId} · catalogue`} — ${(item.artists ?? []).join(", ")} — ${item.title ?? "?"}`,
      );
    }

    console.log(JSON.stringify({ dryRun: true, ok: true, ...summary }));

    return;
  }

  const workdir = mkdtempSync(join(tmpdir(), "fluncle-embed-batch-"));

  try {
    // (1) Pull the audio, CONCURRENTLY. The pod is remote from R2 and the GPU is the expensive
    // thing in the room — it must not sit idle waiting on a serial download chain.
    const downloadable = queue.filter(
      (item): item is WorkItem & { sourceAudioKey: string; trackId: string } =>
        Boolean(item.trackId) && Boolean(item.sourceAudioKey),
    );

    const manifest = (
      await mapWithConcurrency(downloadable, DOWNLOAD_CONCURRENCY, async (item) => {
        const path = join(workdir, `${item.trackId}${sourceAudioExt(item.sourceAudioKey)}`);
        writeFileSync(path, await r2Get(item.sourceAudioKey));

        return { id: item.trackId, path };
      })
    ).filter((entry): entry is { id: string; path: string } => entry !== null);

    summary.downloaded = manifest.length;
    log(`downloaded ${manifest.length}/${downloadable.length} track(s)`);

    if (manifest.length === 0) {
      console.log(JSON.stringify({ ok: true, ...summary }));

      return;
    }

    // (2) ONE python call over the WHOLE batch. The multi-second MuQ model load — and the CUDA
    // context — are paid once, not once per track. That amortization is most of the win.
    const embed = spawnSync(PYTHON_BIN, [EMBED_SCRIPT], {
      encoding: "utf8",
      input: JSON.stringify(manifest),
      maxBuffer: 512 * 1024 * 1024, // a 1024-float vector per track, across a 200-track batch
    });

    if (embed.status !== 0) {
      log(`embed-track exited ${embed.status}: ${(embed.stderr ?? "").trim().slice(-600)}`);
      console.log(JSON.stringify({ ok: false, reason: "embed_failed", ...summary }));
      process.exitCode = 1;

      return;
    }

    let parsed: EmbedOutput;

    try {
      parsed = JSON.parse(embed.stdout ?? "") as EmbedOutput;
    } catch {
      log(`embed-track did not return JSON: ${(embed.stdout ?? "").slice(0, 200)}`);
      console.log(JSON.stringify({ ok: false, reason: "embed_bad_output", ...summary }));
      process.exitCode = 1;

      return;
    }

    // (3) Write the vectors back through the Worker. Serial: the write is milliseconds and the
    // archive is small next to the batch — there is nothing to gain from hammering the API, and
    // a failed write just leaves the track queued for the next run.
    for (const result of parsed.results ?? []) {
      try {
        await writeEmbedding(result.id, result.embedding);
        summary.done += 1;
      } catch (error) {
        summary.writeFailed += 1;
        log(
          `${result.id}: write-back failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    for (const failure of parsed.errors ?? []) {
      summary.failed += 1;
      log(`${failure.id}: embed error — ${failure.error}`);
    }

    console.log(JSON.stringify({ ok: true, ...summary }));
  } finally {
    // The captured songs are PRIVATE audio. They leave the pod's disk on every exit path.
    rmSync(workdir, { force: true, recursive: true });
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
    console.log(JSON.stringify({ ok: false, reason: "fatal" }));
    process.exitCode = 1;
  });
}
