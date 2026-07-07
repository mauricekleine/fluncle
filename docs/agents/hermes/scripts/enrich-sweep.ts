#!/usr/bin/env bun
// enrich-sweep.ts — the bun orchestrator behind the `--no-agent` enrichment cron.
//
// LIVE. Version-controlled source; the repo is canonical and the box is a deploy
// target (fluncle-hermes-operator skill). Invoked by the bash wrapper
// (enrich-sweep.sh) the cron runner execs every ~5m — see that file's header for
// the `hermes cron create` wire-up and ../cron/README.md for the full cron model.
//
// This is the on-box enrichment path: it does the analysis ON the box (ffmpeg +
// bun), so there is no Worker-side enrichment trigger. Pure compute, zero LLM
// tokens.
//
// The loop, idempotent by construction (the queue is `status=queue`: pending ∪
// failed ∪ stale processing, so a `done` finding is already out of it; re-running
// never double-writes), fast no-op when the queue is empty:
//
//   1. `fluncle admin tracks enrich --queue --json`  → the worklist.
//   2. per finding (bounded batch):
//      a. `fluncle tracks get <id> --json`          → artists, title, isrc, trackId.
//      b. `bun .../analyze-track.ts --artist <a> --title <t> [--isrc <i>]`
//                                                    → { bpm, key|null, features }.
//      c. `fluncle admin tracks update <trackId> --bpm <bpm> [--key "<key>"]
//             --features '<json>' --status done`     — `--key` only when non-null;
//         no preview (analyze exit 2) → `--status failed`.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config — bounded batch so a tick stays cheap and a transient failure can't
// stampede the whole queue. The queue itself is the durable worklist; anything
// not reached this tick is picked up on the next (~5m later).
// ---------------------------------------------------------------------------

const BATCH_CAP = 4; // findings analyzed per tick (sane small cap, 3–5 band)
const QUEUE_LIMIT = 50; // hard ceiling on the queue read (we only act on BATCH_CAP)

// On the box: /opt/data/skills (the host-mounted ~/.hermes/skills). Overridable so
// a local dry-run can point at a repo checkout of the skill.
const ANALYZE_SCRIPT =
  process.env.FLUNCLE_ANALYZE_SCRIPT ??
  "/opt/data/skills/fluncle-track-enrichment/scripts/analyze-track.ts";

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";
const BUN_BIN = process.env.BUN_BIN ?? "bun";

// R2 (S3 API) — the PRIVATE fluncle-source-audio bucket the capture sweep writes the
// full song to (RFC docs/full-audio-rfc.md § Unit 1/2). A dedicated, least-privilege
// token: Object Read on this bucket only. Creds come from the shared secrets file
// (enrich-sweep.sh sources it, mirroring capture-sweep.sh); absent creds → a GET 403 →
// the sweep falls back to the preview path (capture must never gate enrichment).
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID ?? "";
const R2_ACCESS_KEY_ID = process.env.FLUNCLE_SOURCE_AUDIO_R2_ACCESS_KEY_ID ?? "";
const R2_SECRET_ACCESS_KEY = process.env.FLUNCLE_SOURCE_AUDIO_R2_SECRET_ACCESS_KEY ?? "";
const R2_BUCKET = process.env.FLUNCLE_SOURCE_AUDIO_R2_BUCKET ?? "fluncle-source-audio";
const R2_ENDPOINT = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

const log = (message: string) => console.error(`[enrich-sweep] ${message}`);

// ---------------------------------------------------------------------------
// Types — only the fields we consume from each surface.
// ---------------------------------------------------------------------------

type QueueFinding = {
  artists?: string[];
  isrc?: string;
  logId?: string;
  // The R2 key of the captured full song, once the capture side-channel has landed it
  // (`<logId>/<sha256>.<ext>`, PRESENCE = captured). A separate slice surfaces it on the
  // admin tracks DTO / `tracks get` payload; read defensively — absent means "no key",
  // so the sweep enriches on the preview exactly as today.
  sourceAudioKey?: string;
  title?: string;
  trackId?: string;
};

type AnalyzeOutput = {
  bpm: number | null;
  bpmSource: string | null;
  features: Record<string, unknown>;
  key: string | null;
};

type Outcome = "done" | "failed" | "skipped";

// ---------------------------------------------------------------------------
// Shell helpers — synchronous, fail-loud where it matters.
// ---------------------------------------------------------------------------

function run(bin: string, args: string[]): { code: number; stderr: string; stdout: string } {
  const result = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

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

// ---------------------------------------------------------------------------
// Pure source-selection helpers (exported for enrich-sweep.test.ts).
// ---------------------------------------------------------------------------

/**
 * Build the analyze-track argv. When `audioFilePath` is set (the captured full song was
 * fetched to a temp file), pass `--audio-file` so the analyzer reads the WHOLE song;
 * otherwise the analyzer resolves + reads the 30s preview itself (no URL passed). The
 * enrich queue is capture-INDEPENDENT — this selects the better SOURCE when it exists,
 * permanently (RFC docs/full-audio-rfc.md § Unit 2), it does not gate the queue.
 */
export function buildAnalyzeArgs(
  script: string,
  fields: { artist: string; audioFilePath?: string; isrc?: string; title: string },
): string[] {
  const args = [script, "--artist", fields.artist, "--title", fields.title];

  if (fields.isrc) {
    args.push("--isrc", fields.isrc);
  }

  if (fields.audioFilePath) {
    args.push("--audio-file", fields.audioFilePath);
  }

  return args;
}

/** The file extension of an R2 source-audio key (`<logId>/<sha256>.<ext>`) → the temp
 * filename's extension. Cosmetic (ffmpeg probes the real container), `"bin"` when none. */
export function extFromKey(key: string): string {
  const base = key.slice(key.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");

  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "bin";
}

// ---------------------------------------------------------------------------
// R2 (S3 API) GET — MIRROR of the signer in capture-sweep.ts (itself a mirror of
// apps/web/src/lib/server/aws-sigv4.ts). Box scripts can't import the workspace, so
// the self-contained copy is the norm; keep it in step with capture-sweep.ts.
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

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

// GET the full song bytes from the private bucket. `key` is the full DTO string, so we
// GET it as-is (never rebuild it). Any non-OK → throw, and the caller falls back to the
// preview path — a missing/broken key must never block enrichment.
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
// Per-finding: get → analyze → write back.
// ---------------------------------------------------------------------------

async function enrichOne(finding: QueueFinding): Promise<Outcome> {
  const id = finding.trackId ?? finding.logId;

  if (!id) {
    log("queue item without a trackId/logId — skipping");

    return "skipped";
  }

  // (a) Re-read the finding to get the canonical artist/title/isrc/trackId/sourceAudioKey.
  // The queue payload already carries them, but a fresh `track get` is the source of truth
  // and tolerates the queue surface changing shape under us. NOTE: the public lookup is the
  // SINGULAR `track get` (only the admin group is plural).
  const finder = fluncleJson<QueueFinding>(["tracks", "get", id]);
  const trackId = finder.trackId ?? finding.trackId;
  const artist = finder.artists?.[0] ?? finding.artists?.[0];
  const title = finder.title ?? finding.title;
  const isrc = finder.isrc ?? finding.isrc;
  const sourceAudioKey = finder.sourceAudioKey ?? finding.sourceAudioKey;

  if (!trackId || !artist || !title) {
    log(`${id}: missing trackId/artist/title — skipping`);

    return "skipped";
  }

  // (b) Pick the analysis SOURCE. When capture has landed the full song (source_audio_key
  // present), S3-GET it to a temp file and analyze THAT; otherwise the analyzer resolves +
  // reads the 30s preview itself. The enrich queue is capture-INDEPENDENT (RFC
  // docs/full-audio-rfc.md § Unit 2) — this only upgrades the source when it exists,
  // permanently; a missing/broken key falls back to the preview and never blocks.
  let audioTmpDir: string | undefined;
  let audioFilePath: string | undefined;

  if (sourceAudioKey) {
    try {
      const bytes = await r2Get(sourceAudioKey);
      audioTmpDir = mkdtempSync(join(tmpdir(), "fluncle-enrich-src-"));
      audioFilePath = join(audioTmpDir, `source.${extFromKey(sourceAudioKey)}`);
      writeFileSync(audioFilePath, bytes);
      log(`${trackId}: analyzing captured full song (${sourceAudioKey})`);
    } catch (error) {
      audioFilePath = undefined;
      if (audioTmpDir) {
        rmSync(audioTmpDir, { force: true, recursive: true });
        audioTmpDir = undefined;
      }
      log(
        `${trackId}: source-audio GET failed (${sourceAudioKey}) — falling back to preview: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  try {
    // (c) Analyze. Exit 2 = no audio / nothing decoded → mark the finding `failed`.
    const analysis = run(
      BUN_BIN,
      buildAnalyzeArgs(ANALYZE_SCRIPT, { artist, audioFilePath, isrc, title }),
    );

    if (analysis.code === 2) {
      log(`${trackId}: no audio available → status=failed`);
      fluncleJson(["admin", "tracks", "update", trackId, "--status", "failed"]);

      return "failed";
    }

    if (analysis.code !== 0) {
      // A genuine analyzer error (not the no-audio signal). Leave the finding in the
      // queue so the next tick retries; don't write a misleading status.
      log(
        `${trackId}: analyze-track exited ${analysis.code}: ${analysis.stderr.trim().slice(-200)}`,
      );

      return "skipped";
    }

    let parsed: AnalyzeOutput;

    try {
      parsed = JSON.parse(analysis.stdout) as AnalyzeOutput;
    } catch {
      log(`${trackId}: analyze-track did not return JSON — leaving queued`);

      return "skipped";
    }

    // (d) Write back. `--key` only when non-null (respect the skill's confidence gate);
    // features always; status=done.
    const updateArgs = ["admin", "tracks", "update", trackId];

    if (parsed.bpm !== null && parsed.bpm !== undefined) {
      updateArgs.push("--bpm", String(parsed.bpm));
    }

    if (parsed.key !== null && parsed.key !== undefined) {
      updateArgs.push("--key", parsed.key);
    }

    updateArgs.push("--features", JSON.stringify(parsed.features ?? {}));
    updateArgs.push("--status", "done");

    fluncleJson(updateArgs);
    // Surface the BPM provenance so a fallback BPM is distinguishable in cron logs (e.g.
    // `via audio-file` for the captured full song, or `via acousticbrainz` when the preview
    // was beatless and the structured ISRC fallback supplied the tempo).
    const bpmVia = parsed.bpm !== null && parsed.bpmSource ? ` via ${parsed.bpmSource}` : "";
    log(`${trackId}: done (bpm ${parsed.bpm ?? "null"}${bpmVia}, key ${parsed.key ?? "null"})`);

    return "done";
  } finally {
    if (audioTmpDir) {
      rmSync(audioTmpDir, { force: true, recursive: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Main — drain a bounded batch off the queue.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // `enrich --queue --json` returns `{ ok: true, tracks: [...] }`, not a bare array.
  const response = fluncleJson<{ tracks?: QueueFinding[] }>([
    "admin",
    "tracks",
    "enrich",
    "--queue",
    "--limit",
    String(QUEUE_LIMIT),
  ]);
  const queue = response.tracks ?? [];

  const summary = { batch: 0, done: 0, failed: 0, queued: queue.length, skipped: 0 };

  if (queue.length === 0) {
    console.log(JSON.stringify({ ok: true, ...summary }));

    return; // fast no-op
  }

  for (const finding of queue.slice(0, BATCH_CAP)) {
    summary.batch += 1;

    try {
      const outcome = await enrichOne(finding);
      summary[outcome] += 1;
    } catch (error) {
      // One finding's failure must not abort the sweep — log it and move on; it
      // stays in the queue for the next tick.
      summary.skipped += 1;
      log(
        `error on ${finding.trackId ?? finding.logId ?? "?"}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  console.log(JSON.stringify({ ok: true, ...summary }));
}

// Guard the entrypoint so importing this module for tests is side-effect free (no
// fluncle spawn, no R2, no network) — mirrors capture-sweep.ts. The bash wrapper execs
// this file directly, so `import.meta.main` is true when the cron runs it.
if (import.meta.main) {
  main().catch((error: unknown) => {
    log(`enrich sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
