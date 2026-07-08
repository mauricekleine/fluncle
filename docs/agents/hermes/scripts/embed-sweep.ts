#!/usr/bin/env bun
// embed-sweep.ts — the bun orchestrator behind the audio-embedding sweep (`fluncle-embed`),
// scheduled by a rave-02 HOST systemd timer (../embed-timer/), not a Hermes gateway cron: a
// windowed full-song MuQ forward is minutes-scale and must not occupy the shared serial
// gateway runner (its ~300s global budget would starve the latency-sensitive 5-min sweeps —
// the same reason capture is a host timer). See ../embed-timer/README.md + docs/rfcs/full-audio-rfc.md § Unit 3.
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
// SOURCE = the CAPTURED FULL SONG, not the 30s preview. The embed queue gates on
// `source_audio_key IS NOT NULL AND embedding_json IS NULL` (the key-gate + the DTO's
// `sourceAudioKey` field are added by a separate slice — this orchestrator CONSUMES them),
// so a queued finding always has a captured full song in the PRIVATE `fluncle-source-audio`
// R2 bucket. We deliberately do NOT embed previews (the blind "quiet piano" vectors are the
// thing this whole effort kills), so a finding with no `sourceAudioKey` is skipped, never
// preview-fetched. The S3 GET mirrors capture-sweep.ts's signer (which mirrors
// apps/web/src/lib/server/aws-sigv4.ts) — keep them in step.
//
// The loop is idempotent by construction (an embedded finding is already out of the
// `embedding_json IS NULL` queue; re-running never double-writes), a fast no-op when the
// queue is empty:
//
//   1. `fluncle admin tracks embed --queue --json`   → the worklist.
//   2. S3-GET each finding's captured full song (`source_audio_key`) → a temp file; build a manifest.
//   3. ONE `python3 embed-track.py` call over the batch → {results, errors}
//      (the MuQ model load is amortized; embed-track.py WINDOWS the long audio to bound RAM).
//   4. per result: `fluncle admin tracks update <trackId> --embedding-file <tmp>`.
//
// The pure helpers below (chooseEmbedSource / sourceAudioExt) are exported + unit-tested in
// embed-sweep.test.ts; `main()` is guarded behind `import.meta.main` so importing this module
// for the tests is side-effect free (it does not read R2 or spawn the embedder).
//
// stdout: one JSON summary line (the run output the /status prober reads). Diagnostics → stderr.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config — BATCH_CAP is 1: a windowed full-song MuQ forward is minutes-scale (each ~30s
// window is a full forward, and a 5-min song is ~10 windows), so one finding per tick keeps
// the wall-clock bounded. As a host timer the 120s/300s gateway kill no longer applies, but
// the queue is still the durable worklist — anything not reached this tick is picked up
// ~5m later, newest-first.
// ---------------------------------------------------------------------------

const BATCH_CAP = 1; // findings embedded per tick (a windowed full-song forward is minutes)
const QUEUE_LIMIT = 50; // hard ceiling on the queue read (we only act on BATCH_CAP)

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";
const PYTHON_BIN = process.env.PYTHON_BIN ?? "python3";
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
  logId?: string;
  // The R2 key for the captured full song (`<logId>/<sha256>.<ext>`), surfaced on the embed
  // queue DTO by a separate slice. PRESENCE means captured; the queue is key-gated, so this is
  // populated for every real row — but we still skip defensively when it is absent (never
  // fall back to the preview).
  sourceAudioKey?: string;
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

const R2_ENDPOINT = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

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

// ---------------------------------------------------------------------------
// Main — drain a bounded batch off the queue.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    console.log(JSON.stringify({ ok: false, reason: "missing_r2_credentials" }));
    process.exitCode = 1;
    return;
  }

  // `embed --queue --json` returns `{ ok: true, tracks: [...] }`, not a bare array.
  const response = fluncleJson<{ tracks?: QueueFinding[] }>([
    "admin",
    "tracks",
    "embed",
    "--queue",
    "--limit",
    String(QUEUE_LIMIT),
  ]);
  const queue = response.tracks ?? [];

  const summary = {
    done: 0,
    failed: 0,
    fetchFailed: 0,
    noSource: 0,
    queued: queue.length,
    skipped: 0,
  };

  if (queue.length === 0) {
    console.log(JSON.stringify({ ok: true, ...summary }));

    return; // fast no-op
  }

  const workdir = mkdtempSync(join(tmpdir(), "fluncle-embed-"));

  try {
    // (1) S3-GET each finding's captured full song; build the MuQ manifest. The queue payload
    // already carries the canonical trackId + the captured `sourceAudioKey`, so no re-read is
    // needed. We GET the full key string as stored (never rebuild it).
    const manifest: { id: string; path: string }[] = [];

    for (const finding of queue.slice(0, BATCH_CAP)) {
      const source = chooseEmbedSource(finding);

      if (source.kind === "skip") {
        if (source.reason === "no_track_id") {
          summary.skipped += 1;
        } else {
          // The queue is key-gated upstream, so this is defensive: a finding with no captured
          // full song is left queued (capture may land it later). We deliberately never embed
          // the 30s preview as a fallback.
          summary.noSource += 1;
          log(`${finding.logId ?? "?"}: no source_audio_key — leaving queued`);
        }
        continue;
      }

      const audioPath = join(workdir, `${source.trackId}${sourceAudioExt(source.key)}`);

      try {
        writeFileSync(audioPath, await r2Get(source.key));
        manifest.push({ id: source.trackId, path: audioPath });
      } catch (error) {
        // A transient R2 error (or a key whose object went missing) — leave it queued; a later
        // tick retries. Never a fallback to the preview.
        summary.fetchFailed += 1;
        log(
          `${source.trackId}: source-audio GET failed for ${source.key}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (manifest.length === 0) {
      console.log(JSON.stringify({ ok: true, ...summary }));
      return;
    }

    // (2) ONE python call over the batch — the MuQ model load is amortized. embed-track.py
    // windows the long audio and mean-pools across windows to bound peak RAM.
    const embed = run(PYTHON_BIN, [EMBED_SCRIPT], JSON.stringify(manifest));

    if (embed.code !== 0) {
      // A batch-level failure (torch import / model load): leave everything queued.
      log(`embed-track exited ${embed.code}: ${embed.stderr.trim().slice(-400)}`);
      summary.skipped += manifest.length;
      console.log(JSON.stringify({ ok: false, reason: "embed_failed", ...summary }));
      process.exitCode = 1;
      return;
    }

    let parsed: EmbedOutput;

    try {
      parsed = JSON.parse(embed.stdout) as EmbedOutput;
    } catch {
      log(`embed-track did not return JSON: ${embed.stdout.slice(0, 200)}`);
      summary.skipped += manifest.length;
      console.log(JSON.stringify({ ok: false, reason: "embed_bad_output", ...summary }));
      process.exitCode = 1;
      return;
    }

    // (3) Write each vector back via the agent-tier update path (a file arg — a
    // 1024-float array is large for an inline flag).
    for (const result of parsed.results ?? []) {
      try {
        const vectorPath = join(workdir, `${result.id}.json`);
        writeFileSync(vectorPath, JSON.stringify(result.embedding));
        fluncleJson(["admin", "tracks", "update", result.id, "--embedding-file", vectorPath]);
        summary.done += 1;
        log(`${result.id}: embedded + written`);
      } catch (error) {
        summary.skipped += 1;
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
    // Temp files (the captured audio + the vector JSON) are cleaned up here regardless of outcome.
    rmSync(workdir, { force: true, recursive: true });
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`[embed-sweep] fatal: ${error instanceof Error ? error.message : String(error)}`);
    console.log(JSON.stringify({ ok: false, reason: "fatal" }));
    process.exitCode = 1;
  });
}
