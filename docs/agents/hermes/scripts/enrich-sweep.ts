#!/usr/bin/env bun
// enrich-sweep.ts — the bun orchestrator behind the `--no-agent` enrichment cron.
//
// LIVE. Version-controlled source; the repo is canonical and the box is a deploy
// target (fluncle-hermes-operator skill). Invoked by the bash wrapper
// (enrich-sweep.sh) the cron runner execs every ~5m — see that file's header for
// the `host-timer` wire-up and ../cron/README.md for the full cron model.
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
// ── THE SECOND ARM: THE CATALOGUE (docs/gpu-batch-embed.md) ─────────────────
//
// The queue above is `status=queue`, which lives on `findings.enrichment_status` and is read
// through the FINDING JOIN — so it is structurally blind to a CATALOGUE track (a `tracks` row
// with no `findings` row). That is correct and it stays: it is the certification's own
// state machine, it is capture-INDEPENDENT (it will analyse a preview when no full song
// exists), and none of that translates to an uncertified row.
//
// But ANALYSIS ITSELF does. BPM, key and the spectral features are measurements of a
// RECORDING — they live on `tracks` — so a catalogue track with captured audio is analysable,
// and must be, or it will never carry the numbers the archive reasons with. So this sweep
// grows a SECOND, additive arm, disjoint from the first by construction (`scope=catalogue`):
//
//   3. GET /api/v1/admin/tracks/work?kind=analyze&scope=catalogue → tracks with captured audio
//      whose stored analysis did not come from it. DATA-derived, not status-derived: there is
//      no `enrichment_status` on a catalogue row to drive a queue with.
//   4. per track: S3-GET the captured song → analyze → `tracks update <id> --bpm … --key …
//      --features … --analyzed-from full`. **NO `--status`**: `enrichment_status` is a
//      CERTIFICATION column and the server 409s an uncertified write of one (the certification
//      rail, track-update.ts). Fluncle measures the track; he does not speak about it.
//
// The catalogue arm is FULL-AUDIO ONLY — no preview fallback. The finding arm has one because
// a certified finding must get its numbers somehow; a catalogue track has no such claim on us,
// and a preview-grade vector/BPM is exactly the garbage the full-audio ruling exists to keep
// out of the archive.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BoxCostEvent, emitCost, selfSecondsCost } from "./cost-emit";

// ---------------------------------------------------------------------------
// Config — bounded batch so a tick stays cheap and a transient failure can't
// stampede the whole queue. The queue itself is the durable worklist; anything
// not reached this tick is picked up on the next (~5m later).
// ---------------------------------------------------------------------------

const BATCH_CAP = 4; // findings analyzed per tick (sane small cap, 3–5 band)
const QUEUE_LIMIT = 50; // hard ceiling on the queue read (we only act on BATCH_CAP)

// The catalogue arm's own cap, spent only AFTER the findings arm has taken what it needs — a
// speculative row never delays a certified one. Env-tunable (the FLUNCLE_LABEL_LINEAGE_LIMIT
// precedent) so the catch-up pace is a unit-file knob, not a rebake: measured 2026-07-20, a
// 2-row tick used 8–15s of its 5-minute window while capture ran ~2,200/day — the baked cap
// was the pipeline's sandbag. The default stays the conservative 2; the enrich timer unit
// passes the raised catch-up value, and saturation later means deleting one env line.
const CATALOGUE_BATCH_CAP = Number(process.env.FLUNCLE_ENRICH_CATALOGUE_BATCH ?? "2");

// The queue read for the catalogue arm goes over DIRECT HTTP, not the baked CLI: the box's
// `fluncle` binary is a PINNED release, so a read through a new CLI command would gate this
// sweep behind a pin bump. The write-back is the EXISTING `tracks update` command, unchanged.
const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";

// On the box: the BAKED enrichment skill at /opt/hermes-skills (Unit A — the skill rides
// the image and auto-updates from main via pin-watch; no hand-cp'd /opt/data/skills copy).
// Overridable so a local dry-run can point at a repo checkout of the skill.
const ANALYZE_SCRIPT =
  process.env.FLUNCLE_ANALYZE_SCRIPT ??
  "/opt/hermes-skills/fluncle-track-enrichment/scripts/analyze-track.ts";

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";
const BUN_BIN = process.env.BUN_BIN ?? "bun";

// R2 (S3 API) — the PRIVATE fluncle-source-audio bucket the capture sweep writes the
// full song to (docs/track-lifecycle.md). A dedicated, least-privilege
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
  bpmConfidence: number | null;
  bpmSource: string | null;
  features: Record<string, unknown>;
  key: string | null;
  keyConfidence: number | null;
  keySource: string | null;
};

type Outcome = "done" | "failed" | "skipped";

// The outcome plus the self-seconds cost row to emit — non-null whenever the analyze
// compute actually RAN (done / failed / analyzer-error), null on the pre-analyze
// skips. The box-seconds are a real spend regardless of the analysis result, so unlike
// the authoring rows this records `failed` too (it tracks compute, not delivered copy).
type EnrichResult = { cost: BoxCostEvent | null; outcome: Outcome };

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
 * permanently (docs/track-lifecycle.md), it does not gate the queue.
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

async function enrichOne(finding: QueueFinding): Promise<EnrichResult> {
  const id = finding.trackId ?? finding.logId;

  if (!id) {
    log("queue item without a trackId/logId — skipping");

    return { cost: null, outcome: "skipped" };
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

    return { cost: null, outcome: "skipped" };
  }

  const logId = finder.logId ?? finding.logId ?? null;

  // (b) Pick the analysis SOURCE. When capture has landed the full song (source_audio_key
  // present), S3-GET it to a temp file and analyze THAT; otherwise the analyzer resolves +
  // reads the 30s preview itself. The enrich queue is capture-INDEPENDENT (RFC
  // docs/track-lifecycle.md) — this only upgrades the source when it exists,
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
    // Time the analyze compute (ffmpeg + the DSP) for the self-seconds cost row — the
    // box-seconds are the spend, so the row is built here and attributed to every
    // outcome where the analyzer actually RAN (done / failed / analyzer-error).
    const analyzeStart = Date.now();
    const analysis = run(
      BUN_BIN,
      buildAnalyzeArgs(ANALYZE_SCRIPT, { artist, audioFilePath, isrc, title }),
    );
    const cost = selfSecondsCost({
      logId,
      occurredAt: new Date().toISOString(),
      seconds: (Date.now() - analyzeStart) / 1000,
      step: "enrich",
      trackId,
    });

    if (analysis.code === 2) {
      log(`${trackId}: no audio available → status=failed`);
      fluncleJson(["admin", "tracks", "update", trackId, "--status", "failed"]);

      return { cost, outcome: "failed" };
    }

    if (analysis.code !== 0) {
      // A genuine analyzer error (not the no-audio signal). Leave the finding in the
      // queue so the next tick retries; don't write a misleading status.
      log(
        `${trackId}: analyze-track exited ${analysis.code}: ${analysis.stderr.trim().slice(-200)}`,
      );

      return { cost, outcome: "skipped" };
    }

    let parsed: AnalyzeOutput;

    try {
      parsed = JSON.parse(analysis.stdout) as AnalyzeOutput;
    } catch {
      log(`${trackId}: analyze-track did not return JSON — leaving queued`);

      return { cost, outcome: "skipped" };
    }

    // (d) Write back. `--key` only when non-null (respect the skill's confidence gate);
    // features always; status=done. ALSO write the analysis PROVENANCE (RFC
    // bpm-key-accuracy): `--analyzed-from` = "full" when we analyzed the captured song
    // (--audio-file), else "preview"; `--analyzed-at` = now, on EVERY successful analysis.
    // The bpm/key SOURCE + CONFIDENCE ride along only when the matching value was written
    // (the sweep writes --bpm/--key only when non-null), so provenance never claims a
    // source for a value the row didn't get.
    const updateArgs = ["admin", "tracks", "update", trackId];
    const analyzedFrom = audioFilePath ? "full" : "preview";

    if (parsed.bpm !== null && parsed.bpm !== undefined) {
      updateArgs.push("--bpm", String(parsed.bpm));

      if (parsed.bpmSource) {
        updateArgs.push("--bpm-source", parsed.bpmSource);
      }

      if (parsed.bpmConfidence !== null && parsed.bpmConfidence !== undefined) {
        updateArgs.push("--bpm-confidence", String(parsed.bpmConfidence));
      }
    }

    if (parsed.key !== null && parsed.key !== undefined) {
      updateArgs.push("--key", parsed.key);

      if (parsed.keySource) {
        updateArgs.push("--key-source", parsed.keySource);
      }

      if (parsed.keyConfidence !== null && parsed.keyConfidence !== undefined) {
        updateArgs.push("--key-confidence", String(parsed.keyConfidence));
      }
    }

    updateArgs.push("--features", JSON.stringify(parsed.features ?? {}));
    updateArgs.push("--analyzed-from", analyzedFrom);
    updateArgs.push("--analyzed-at", new Date().toISOString());
    updateArgs.push("--status", "done");

    fluncleJson(updateArgs);
    // Surface the BPM provenance so a fallback BPM is distinguishable in cron logs (e.g.
    // `via audio-file` for the captured full song, or `via acousticbrainz` when the preview
    // was beatless and the structured ISRC fallback supplied the tempo).
    const bpmVia = parsed.bpm !== null && parsed.bpmSource ? ` via ${parsed.bpmSource}` : "";
    log(`${trackId}: done (bpm ${parsed.bpm ?? "null"}${bpmVia}, key ${parsed.key ?? "null"})`);

    return { cost, outcome: "done" };
  } finally {
    if (audioTmpDir) {
      rmSync(audioTmpDir, { force: true, recursive: true });
    }
  }
}

// ---------------------------------------------------------------------------
// THE CATALOGUE ARM — analyse an uncertified track from its captured full song.
// ---------------------------------------------------------------------------

/** One row of the catalogue analyze worklist (`list_track_work`). */
type CatalogueWorkItem = {
  artists?: string[];
  certified?: boolean;
  isrc?: null | string;
  sourceAudioKey?: null | string;
  title?: string;
  trackId?: string;
};

/**
 * The catalogue analyze worklist: tracks with captured audio whose stored analysis did not
 * come from it. `scope=catalogue` makes it DISJOINT from the findings queue above, so no
 * track is ever worked twice in a tick.
 */
async function fetchCatalogueAnalyzeQueue(): Promise<CatalogueWorkItem[]> {
  const url = `${API_BASE_URL}/api/v1/admin/tracks/work?kind=analyze&scope=catalogue&limit=${QUEUE_LIMIT}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    // `list_track_work` is ~10s p95 with a tail past 30s, so a 30s budget tripped a false
    // failure alert on the slow-but-completing read; 60s clears the tail (the cron's own kill
    // is the real backstop). This is the Worker API worklist read, never a media download.
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    throw new Error(
      `catalogue analyze queue read failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }

  const body = (await res.json()) as { tracks?: CatalogueWorkItem[] };

  return Array.isArray(body.tracks) ? body.tracks : [];
}

/**
 * Analyse ONE catalogue track from its captured full song, and write the measurements back.
 *
 * Three things differ from `enrichOne`, all of them consequences of the track being
 * uncertified:
 *
 *   · NO `tracks get` re-read. That is a PUBLIC read and it resolves through the finding join,
 *     so it 404s on a catalogue track. The work-queue payload is the source of truth here.
 *   · NO PREVIEW FALLBACK. The queue is key-gated; a missing/broken key leaves the row queued
 *     for a later tick rather than reaching for a 30s preview (a preview-grade BPM/key is the
 *     garbage the full-audio ruling exists to keep out).
 *   · NO `--status`. `enrichment_status` is a CERTIFICATION column; the server 409s an
 *     uncertified write of one. Fluncle measures this track. He does not speak about it.
 */
async function analyzeCatalogueOne(item: CatalogueWorkItem): Promise<EnrichResult> {
  const trackId = item.trackId;
  const artist = item.artists?.[0];
  const title = item.title;
  const sourceAudioKey = item.sourceAudioKey;

  if (!trackId || !artist || !title) {
    log("catalogue item without a trackId/artist/title — skipping");

    return { cost: null, outcome: "skipped" };
  }

  if (!sourceAudioKey) {
    // The queue is key-gated upstream, so this is defensive. Never a preview fallback.
    log(`${trackId}: catalogue row with no source_audio_key — leaving queued`);

    return { cost: null, outcome: "skipped" };
  }

  const audioTmpDir = mkdtempSync(join(tmpdir(), "fluncle-enrich-cat-"));

  try {
    const audioFilePath = join(audioTmpDir, `source.${extFromKey(sourceAudioKey)}`);
    writeFileSync(audioFilePath, await r2Get(sourceAudioKey));

    const analyzeStart = Date.now();
    const analysis = run(
      BUN_BIN,
      buildAnalyzeArgs(ANALYZE_SCRIPT, {
        artist,
        audioFilePath,
        isrc: item.isrc ?? undefined,
        title,
      }),
    );
    const cost = selfSecondsCost({
      logId: null,
      occurredAt: new Date().toISOString(),
      seconds: (Date.now() - analyzeStart) / 1000,
      step: "enrich",
      trackId,
    });

    if (analysis.code !== 0) {
      // Including exit 2 (nothing decoded). There is no `enrichment_status` to mark `failed`
      // on a catalogue row, so a bad analysis simply leaves it queued; if the captured bytes
      // are genuinely undecodable it will retry, cheaply, and the capture side owns that.
      log(`${trackId}: analyze-track exited ${analysis.code} — leaving queued`);

      return { cost, outcome: "skipped" };
    }

    let parsed: AnalyzeOutput;

    try {
      parsed = JSON.parse(analysis.stdout) as AnalyzeOutput;
    } catch {
      log(`${trackId}: analyze-track did not return JSON — leaving queued`);

      return { cost, outcome: "skipped" };
    }

    const updateArgs = ["admin", "tracks", "update", trackId];

    if (parsed.bpm !== null && parsed.bpm !== undefined) {
      updateArgs.push("--bpm", String(parsed.bpm));

      if (parsed.bpmSource) {
        updateArgs.push("--bpm-source", parsed.bpmSource);
      }

      if (parsed.bpmConfidence !== null && parsed.bpmConfidence !== undefined) {
        updateArgs.push("--bpm-confidence", String(parsed.bpmConfidence));
      }
    }

    if (parsed.key !== null && parsed.key !== undefined) {
      updateArgs.push("--key", parsed.key);

      if (parsed.keySource) {
        updateArgs.push("--key-source", parsed.keySource);
      }

      if (parsed.keyConfidence !== null && parsed.keyConfidence !== undefined) {
        updateArgs.push("--key-confidence", String(parsed.keyConfidence));
      }
    }

    updateArgs.push("--features", JSON.stringify(parsed.features ?? {}));
    // `analyzed_from = full` is what takes the row OUT of the analyze queue — it is the
    // queue's own done-marker, standing in for the `enrichment_status` a catalogue row lacks.
    updateArgs.push("--analyzed-from", "full");
    updateArgs.push("--analyzed-at", new Date().toISOString());

    fluncleJson(updateArgs);
    log(`${trackId}: catalogue done (bpm ${parsed.bpm ?? "null"}, key ${parsed.key ?? "null"})`);

    return { cost, outcome: "done" };
  } finally {
    rmSync(audioTmpDir, { force: true, recursive: true });
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

  const summary = {
    batch: 0,
    catalogueDone: 0,
    catalogueQueued: 0,
    done: 0,
    failed: 0,
    queued: queue.length,
    skipped: 0,
  };

  // The tick's self-seconds rows, POSTed once at the end (best-effort, after the
  // write-backs are already durable — a dropped POST only understates the ledger).
  const costs: BoxCostEvent[] = [];

  // ── ARM 1: the certified findings. Untouched — status-driven, capture-independent,
  // preview-capable. It gets the batch budget FIRST: a speculative catalogue row never
  // delays a track Fluncle has already said yes to.
  for (const finding of queue.slice(0, BATCH_CAP)) {
    summary.batch += 1;

    try {
      const { cost, outcome } = await enrichOne(finding);

      if (cost) {
        costs.push(cost);
      }

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

  // ── ARM 2: the catalogue. Additive and disjoint (`scope=catalogue`), so nothing above is
  // re-worked. Analysis is a measurement of a RECORDING, so an uncertified track with captured
  // audio is analysable — and must be, or the archive never learns its BPM or key. A failure
  // here must never take the findings arm's summary down with it: the whole arm is wrapped.
  if (API_TOKEN) {
    try {
      const catalogueQueue = await fetchCatalogueAnalyzeQueue();
      summary.catalogueQueued = catalogueQueue.length;

      for (const item of catalogueQueue.slice(0, CATALOGUE_BATCH_CAP)) {
        try {
          const { cost, outcome } = await analyzeCatalogueOne(item);

          if (cost) {
            costs.push(cost);
          }

          if (outcome === "done") {
            summary.catalogueDone += 1;
          } else {
            summary.skipped += 1;
          }
        } catch (error) {
          summary.skipped += 1;
          log(
            `error on catalogue ${item.trackId ?? "?"}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } catch (error) {
      // The catalogue arm is best-effort. A queue read that fails (an older Worker without the
      // op, a transient 5xx) must not fail the tick — the findings arm already did its work.
      log(`catalogue arm skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(JSON.stringify({ ok: true, ...summary }));

  // Record the tick's compute spend, best-effort, AFTER the summary is printed (the
  // cron parses the summary as its last stdout line; emitCost only logs to stderr).
  await emitCost(costs);
}

// Guard the entrypoint so importing this module for tests is side-effect free (no
// fluncle spawn, no R2, no network) — mirrors capture-sweep.ts. The bash wrapper execs
// this file directly, so `import.meta.main` is true when the cron runs it.
if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log(`enrich sweep failed: ${message}`);
    // Emit the `{ ok: false }` summary line to STDOUT so the /status marker (cron-output.sh
    // captures stdout only) sees the failure — parity with the sibling sweeps' catch.
    console.log(JSON.stringify({ error: message, ok: false, reason: "enrich_failed" }));
    process.exit(1);
  });
}
