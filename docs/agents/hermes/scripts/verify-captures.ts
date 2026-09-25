#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DueWorkRepairPendingGate,
  dueWorkRepairPendingGate,
  failureBodyUnlessRepairPending,
  isDueWorkRepairPending,
} from "./due-work-repair-pending";
import {
  fetchPreviewFingerprint,
  fpcalcFingerprint,
  resolveSearchPreviewFingerprint,
  type SearchReferenceResult,
  slidingWindowMatch,
} from "./fingerprint-match";

const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID ?? "";
const R2_ACCESS_KEY_ID = process.env.FLUNCLE_SOURCE_AUDIO_R2_ACCESS_KEY_ID ?? "";
const R2_SECRET_ACCESS_KEY = process.env.FLUNCLE_SOURCE_AUDIO_R2_SECRET_ACCESS_KEY ?? "";
const R2_BUCKET = process.env.FLUNCLE_SOURCE_AUDIO_R2_BUCKET ?? "fluncle-source-audio";

const FPCALC_BIN = process.env.FPCALC_BIN ?? "fpcalc";

const BATCH = Number(process.env.FLUNCLE_VERIFY_BATCH ?? "20");

const log = (message: string) => console.error(`[verify-captures] ${message}`);

export type VerifyWorkItem = {
  artists?: string[];
  certified?: boolean;

  durationMs?: number;

  isrc?: null | string;
  logId?: null | string;
  sourceAudioKey?: string;
  title?: string;
  trackId?: string;
};

export type Verdict = "match" | "mismatch" | "no-preview";

export type VerifyQueue = {
  queued?: number;
  tracks: VerifyWorkItem[];
};

export type VerifySummary = {
  checked: number;
  error: null | string;
  errors: number;
  failed: number;
  flaggedFindings: number;
  matched: number;
  ok: boolean;
  produced: number;
  quarantinedCatalogue: number;

  queue_depth?: number;

  searchMatched: number;

  searchMismatch: number;

  skipped: number;
  unverified: number;
  verified: number;
} & Partial<DueWorkRepairPendingGate>;

export type VerifyDeps = {
  fingerprintFile: (path: string) => number[] | null;

  fetchPreviewFp: (trackId: string) => Promise<number[] | null>;
  fetchQueue: (limit: number) => Promise<VerifyQueue>;

  fetchCapture: (key: string, dir: string) => Promise<null | string>;
  log: (message: string) => void;
  mkWorkdir: () => string;
  report: (trackId: string, verdict: Verdict) => Promise<string>;

  resolveSearchFp: (item: VerifyWorkItem) => Promise<SearchReferenceResult>;
  rmWorkdir: (dir: string) => void;
};

export function deriveVerdict(
  previewFp: number[] | null,
  captureFp: number[] | null,
): null | Verdict {
  if (previewFp === null) {
    return "no-preview";
  }

  if (captureFp === null) {
    return null;
  }

  const result = slidingWindowMatch(previewFp, captureFp);

  if (result === null) {
    return "no-preview";
  }

  return result.match ? "match" : "mismatch";
}

export async function runVerifyTick(batch: number, deps: VerifyDeps): Promise<VerifySummary> {
  const summary: VerifySummary = {
    checked: 0,
    error: null,
    errors: 0,
    failed: 0,
    flaggedFindings: 0,
    matched: 0,
    ok: true,
    produced: 0,
    quarantinedCatalogue: 0,
    searchMatched: 0,
    searchMismatch: 0,
    skipped: 0,
    unverified: 0,
    verified: 0,
  };

  let queue: VerifyQueue;

  try {
    queue = await deps.fetchQueue(batch);
  } catch (error) {
    if (isDueWorkRepairPending(error)) {
      deps.log(error.message);

      return { ...summary, ...dueWorkRepairPendingGate(summary) };
    }

    summary.ok = false;
    summary.errors = 1;
    summary.error = error instanceof Error ? error.message : String(error);

    return summary;
  }

  for (const item of queue.tracks) {
    const { sourceAudioKey, trackId } = item;

    if (!trackId || !sourceAudioKey) {
      summary.skipped += 1;
      continue;
    }

    const dir = deps.mkWorkdir();

    try {
      const trusted = Boolean(item.isrc);
      let referenceFp: number[] | null;

      if (trusted) {
        referenceFp = await deps.fetchPreviewFp(trackId);
      } else {
        const resolved = await deps.resolveSearchFp(item);

        referenceFp = resolved.fingerprint;

        if (resolved.fingerprint === null) {
          deps.log(`${trackId}: no title+artist reference (${resolved.reason})`);
        }
      }

      let verdict: null | Verdict;

      if (referenceFp === null) {
        verdict = "no-preview";
      } else {
        const capturePath = await deps.fetchCapture(sourceAudioKey, dir);

        if (capturePath === null) {
          deps.log(`${trackId}: capture read failed — skipped`);
          summary.skipped += 1;
          continue;
        }

        const raw = deriveVerdict(referenceFp, deps.fingerprintFile(capturePath));

        if (raw === null) {
          deps.log(`${trackId}: capture fingerprint failed — skipped`);
          summary.skipped += 1;
          continue;
        }

        if (raw === "mismatch" && !trusted) {
          deps.log(
            `${trackId}: title+artist reference MISMATCH — abstaining (unverified), not condemning`,
          );
          summary.searchMismatch += 1;
          verdict = "no-preview";
        } else {
          verdict = raw;

          if (raw === "match" && !trusted) {
            summary.searchMatched += 1;
          }
        }
      }

      const action = await deps.report(trackId, verdict);

      summary.verified += 1;

      if (action === "preview-match") {
        summary.matched += 1;
      } else if (action === "unverified") {
        summary.unverified += 1;
      } else if (action === "quarantined-catalogue") {
        deps.log(`${trackId}: MISMATCH on a catalogue row — quarantined for re-capture`);
        summary.quarantinedCatalogue += 1;
      } else if (action === "flagged-finding") {
        deps.log(
          `${trackId} (${item.logId ?? "?"}): MISMATCH on a FINDING — attention item raised; the operator rules with flag-wrong-audio`,
        );
        summary.flaggedFindings += 1;
      } else if (action === "operator-verified") {
        deps.log(
          `${trackId}: capture is operator-verified (pinned source) — the server stepped aside; verdict ${verdict} not applied`,
        );
      } else {
        deps.log(`${trackId}: nothing to verify anymore (${action})`);
      }
    } catch (error) {
      deps.log(`${trackId}: ${error instanceof Error ? error.message : String(error)}`);
      summary.skipped += 1;
    } finally {
      deps.rmWorkdir(dir);
    }
  }

  summary.checked = summary.verified + summary.skipped;
  summary.produced = summary.verified;
  summary.failed = summary.skipped;

  if (queue.queued !== undefined) {
    summary.queue_depth = Math.max(0, queue.queued - summary.verified);
  }

  return summary;
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

const R2_ENDPOINT = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

async function fetchVerifyQueue(limit: number): Promise<VerifyQueue> {
  const url = `${API_BASE_URL}/api/v1/admin/catalogue/captures/unverified?limit=${limit}&count=true`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await failureBodyUnlessRepairPending(res, "verify queue read");
    throw new Error(`verify queue read failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const body = (await res.json()) as { queued?: unknown; tracks?: VerifyWorkItem[] };
  const queued =
    typeof body.queued === "number" && Number.isInteger(body.queued) && body.queued >= 0
      ? body.queued
      : undefined;

  return {
    ...(queued === undefined ? {} : { queued }),
    tracks: Array.isArray(body.tracks) ? body.tracks : [],
  };
}

async function fetchCaptureFile(key: string, dir: string): Promise<null | string> {
  const url = `${R2_ENDPOINT}/${R2_BUCKET}/${encodeKey(key)}`;

  let res: Response;

  try {
    res = await fetch(url, { headers: await signS3Get(url), method: "GET" });
  } catch {
    return null;
  }

  if (!res.ok) {
    return null;
  }

  const base = key.slice(key.lastIndexOf("/") + 1) || "capture.audio";
  const path = join(dir, base);

  writeFileSync(path, new Uint8Array(await res.arrayBuffer()));

  return path;
}

async function reportVerdict(trackId: string, verdict: Verdict): Promise<string> {
  const res = await fetch(`${API_BASE_URL}/api/v1/admin/catalogue/captures/verify`, {
    body: JSON.stringify({ trackId, verdict }),
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(
      `verify_capture ${trackId} failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }

  const body = (await res.json()) as { action?: string };

  return body.action ?? "unknown";
}

export function fpcalcAvailable(bin: string = FPCALC_BIN): boolean {
  try {
    const result = spawnSync(bin, ["-version"], { encoding: "utf8", timeout: 10_000 });

    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

export function fpcalcMissingSummary(): VerifySummary & { reason: "fpcalc_missing" } {
  return {
    checked: 0,
    error: null,
    errors: 0,
    failed: 0,
    flaggedFindings: 0,
    matched: 0,
    ok: true,
    produced: 0,
    quarantinedCatalogue: 0,
    reason: "fpcalc_missing",
    searchMatched: 0,
    searchMismatch: 0,
    skipped: 0,
    unverified: 0,
    verified: 0,
  };
}

async function main(): Promise<void> {
  const started = Date.now();

  if (!API_TOKEN) {
    console.log(
      JSON.stringify({
        checked: 0,
        errors: 1,
        failed: 0,
        ok: false,
        produced: 0,
        reason: "missing_api_token",
      }),
    );
    process.exit(1);
  }
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    console.log(
      JSON.stringify({
        checked: 0,
        errors: 1,
        failed: 0,
        ok: false,
        produced: 0,
        reason: "missing_r2_credentials",
      }),
    );
    process.exit(1);
  }

  if (!fpcalcAvailable()) {
    log("fpcalc is not on PATH — the image needs the chromaprint rebake; nothing verified");
    console.log(JSON.stringify(fpcalcMissingSummary()));

    return;
  }

  const deps: VerifyDeps = {
    fetchCapture: fetchCaptureFile,
    fetchPreviewFp: (trackId) =>
      fetchPreviewFingerprint({
        apiBaseUrl: API_BASE_URL,
        apiToken: API_TOKEN,
        fpcalcBin: FPCALC_BIN,
        idOrLogId: trackId,
      }),
    fetchQueue: fetchVerifyQueue,
    fingerprintFile: (path) => fpcalcFingerprint(path, FPCALC_BIN),
    log,
    mkWorkdir: () => mkdtempSync(join(tmpdir(), "fluncle-verify-captures-")),
    report: reportVerdict,
    resolveSearchFp: (item) =>
      resolveSearchPreviewFingerprint({
        artists: item.artists ?? [],
        durationMs: item.durationMs,
        fpcalcBin: FPCALC_BIN,
        title: item.title ?? "",
      }),
    rmWorkdir: (dir) => rmSync(dir, { force: true, recursive: true }),
  };

  const summary = await runVerifyTick(
    Number.isFinite(BATCH) && BATCH > 0 ? Math.trunc(BATCH) : 20,
    deps,
  );

  console.log(JSON.stringify({ ...summary, elapsedMs: Date.now() - started }));

  if (!summary.ok) {
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log(`verify-captures failed: ${message}`);
    console.log(
      JSON.stringify({
        checked: 0,
        error: message,
        errors: 1,
        failed: 0,
        ok: false,
        produced: 0,
        reason: "verify_failed",
      }),
    );
    process.exit(1);
  });
}
