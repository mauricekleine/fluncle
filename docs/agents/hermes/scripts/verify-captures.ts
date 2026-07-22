#!/usr/bin/env bun
// verify-captures.ts — the bun orchestrator behind the CAPTURE-VERIFICATION backfill
// (`fluncle-verify-captures`), scheduled by a rave-02 HOST systemd timer (../verify-captures-timer/).
// THE HISTORIC HALF of the verification gate (docs/the-ear.md § Wrong audio): the capture sweep's
// ingest gate verifies every NEW download, and this sweep walks every capture that landed BEFORE
// the gate existed (~590 rows: findings + catalogue) and gives each the same fingerprint check.
//
// LIVE-INTENT. Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (verify-captures.sh) the host timer
// docker-execs — see that file's header for the wire-up and ../verify-captures-timer/README.md for
// the operator runbook.
//
// ── TWO RUNGS FOR THE REFERENCE (docs/the-ear.md § Wrong audio) ─────────────────────────────
// A row's verification REFERENCE is resolved by one of two rungs, by trust:
//   - ISRC row → the ISRC-resolved official preview through `/api/preview` (the trusted rung). A
//     mismatch against it is trustworthy, so the server may rewind on it.
//   - ISRC-NULL row → a TITLE + ARTIST search reference (the second rung, resolveSearchPreview-
//     Fingerprint), for the ~221 rows that can never reach an ISRC preview. It is LOWER trust
//     (folded-identity + duration guarded, but not byte-exact), so it may only ever CONFIRM a
//     capture: a mismatch against it is mapped to the honest abstain (`unverified`), NEVER a
//     `mismatch` verdict. A wrong reference can leave a row unverified; it can never quarantine
//     good audio. Precision over recall.
//
// ── WHAT ONE ROW COSTS, AND WHO DECIDES WHAT HAPPENS ────────────────────────────────────
// Per row: one private-R2 GET (the captured bytes — the same read + creds embed-batch.ts uses,
// which is what the box's AGENT-scoped R2 token can already do), one reference fetch (the ISRC
// preview, or — for the second rung — one 1 req/s iTunes search + one preview fetch), two
// `fpcalc -raw -json` runs, one sliding-window match (fingerprint-match.ts — the SAME matcher the
// ingest gate uses, so the two cannot drift), and one agent-tier `verify_capture` POST. The box
// only MEASURES and reports a plain verdict (match | mismatch | no-preview); the WORKER routes it
// (apps/web/src/lib/server/catalogue.ts):
//   - match      → `capture_verification = 'preview-match'`.
//   - no-preview → `'unverified'` (the honest abstain — no reference exists).
//   - mismatch on a CATALOGUE row → the wrong-audio quarantine rewind (vector dropped, re-queued
//     for capture, sha remembered in the bad-audio memory).
//   - mismatch on a FINDING → `'mismatch'` stamped ONLY: a machine never rewinds a public finding.
//     It raises the `capture-suspect` /admin attention item; the operator rules with
//     `flag_wrong_audio` (or `fluncle admin catalogue flag-wrong-audio <trackId>`).
// Keeping the routing server-side means the doctrine has ONE authority, integration-tested, and a
// re-baked box script can never invent a new policy.
//
// ── BOUNDED, RESUMABLE, IDEMPOTENT ───────────────────────────────────────────────────────
// The worklist is `list_unverified_captures` — captured rows with `capture_verification IS NULL`.
// A verdict stamps the column, so a verified row LEAVES the set: re-running after a crash simply
// picks up what is left (the embed-queue pattern; no cursor to persist), a stamped row is never
// re-verified, and a drained backlog makes the tick a single empty read. Each tick takes at most
// `FLUNCLE_VERIFY_BATCH` rows (default 20) — ~590 historic rows drain in ~30 ticks.
//
// ── DEGRADES HONESTLY WITHOUT fpcalc ─────────────────────────────────────────────────────
// fpcalc (chromaprint) joins the Hermes image in the same PR that ships this sweep, but the image
// needs a REBAKE to pick it up. Until then — or on any box without the binary — the probe below
// detects its absence and the tick exits cleanly with `reason: "fpcalc_missing"` WITHOUT stamping
// anything: rows stay unverified (still queued) rather than being wrongly marked, and nothing
// crashes. The repo half is safe to merge before the rebake.
//
// FULL-AUDIO-ONLY is untouched: the preview is fetched as a verification REFERENCE, fingerprinted,
// and deleted — it never feeds a vector and is never stored as analysis input.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchPreviewFingerprint,
  fpcalcFingerprint,
  resolveSearchPreviewFingerprint,
  type SearchReferenceResult,
  slidingWindowMatch,
} from "./fingerprint-match";

// ── Config (env; the shared ~/.fluncle-secrets.env supplies the secrets on the box) ──

const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";

// The PRIVATE source-audio bucket — READ-ONLY here (the same credential capture writes with).
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID ?? "";
const R2_ACCESS_KEY_ID = process.env.FLUNCLE_SOURCE_AUDIO_R2_ACCESS_KEY_ID ?? "";
const R2_SECRET_ACCESS_KEY = process.env.FLUNCLE_SOURCE_AUDIO_R2_SECRET_ACCESS_KEY ?? "";
const R2_BUCKET = process.env.FLUNCLE_SOURCE_AUDIO_R2_BUCKET ?? "fluncle-source-audio";

const FPCALC_BIN = process.env.FPCALC_BIN ?? "fpcalc";

/** Rows per tick. ~590 historic captures drain in ~30 ticks at the default. */
const BATCH = Number(process.env.FLUNCLE_VERIFY_BATCH ?? "20");

const log = (message: string) => console.error(`[verify-captures] ${message}`);

// ── Types (the two ops' envelopes — only the fields consumed) ────────────────

export type VerifyWorkItem = {
  artists?: string[];
  certified?: boolean;
  /** The row's stored length — the TITLE+ARTIST rung's duration guard reads it. */
  durationMs?: number;
  /** Null on the 221 rows this rung exists for: they resolve a reference by title+artist, not ISRC. */
  isrc?: null | string;
  logId?: null | string;
  sourceAudioKey?: string;
  title?: string;
  trackId?: string;
};

export type Verdict = "match" | "mismatch" | "no-preview";

/** One tick's honest tally — the JSON summary line. */
export type VerifySummary = {
  error: null | string;
  flaggedFindings: number;
  matched: number;
  ok: boolean;
  quarantinedCatalogue: number;
  /** ISRC-null rows CONFIRMED by a title+artist reference (a subset of `matched`). */
  searchMatched: number;
  /** ISRC-null rows whose title+artist reference MISMATCHED — abstained (unverified), NEVER condemned. */
  searchMismatch: number;
  /** Rows this tick could not settle (a failed R2 read / fpcalc decode) — retried next tick. */
  skipped: number;
  unverified: number;
  verified: number;
};

/**
 * Everything the drain loop touches that is not pure — injected so the verdict derivation and the
 * routing calls are provable with stubs (verify-captures.test.ts): no R2, no fpcalc, no network.
 */
export type VerifyDeps = {
  /** Fingerprint one downloaded capture file; null = fpcalc absent / bad decode. */
  fingerprintFile: (path: string) => number[] | null;
  /** Fetch + fingerprint the track's ISRC-resolved official preview; null = no preview source. */
  fetchPreviewFp: (trackId: string) => Promise<number[] | null>;
  fetchQueue: (limit: number) => Promise<VerifyWorkItem[]>;
  /** Pull the captured bytes from the private bucket into a scratch file; null = R2 read failed. */
  fetchCapture: (key: string, dir: string) => Promise<null | string>;
  log: (message: string) => void;
  mkWorkdir: () => string;
  report: (trackId: string, verdict: Verdict) => Promise<string>;
  /**
   * Resolve a LOWER-TRUST reference fingerprint for an ISRC-null row by TITLE + ARTIST search
   * (the second rung). Returns a fingerprint on a confident single hit, else an abstain reason.
   */
  resolveSearchFp: (item: VerifyWorkItem) => Promise<SearchReferenceResult>;
  rmWorkdir: (dir: string) => void;
};

/**
 * Derive one row's verdict from the two fingerprints. PURE — the whole doctrine of "who is
 * inconclusive" lives here, unit-tested:
 *   - no preview fp        → `no-preview` (the track has no reference; the server stamps
 *                            `unverified`, the honest abstain).
 *   - no capture fp        → null (fpcalc failed on OUR OWN bytes — a decode problem, not a
 *                            verdict; the row is SKIPPED and retried, never mis-stamped).
 *   - inconclusive window  → `no-preview` (a degenerate/too-short fingerprint cannot accuse).
 *   - match / mismatch     → the sliding-window BER against the shared threshold.
 */
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

/** One tick: read the worklist, verify each row, report each verdict. Injected effects. */
export async function runVerifyTick(batch: number, deps: VerifyDeps): Promise<VerifySummary> {
  const summary: VerifySummary = {
    error: null,
    flaggedFindings: 0,
    matched: 0,
    ok: true,
    quarantinedCatalogue: 0,
    searchMatched: 0,
    searchMismatch: 0,
    skipped: 0,
    unverified: 0,
    verified: 0,
  };

  let queue: VerifyWorkItem[];

  try {
    queue = await deps.fetchQueue(batch);
  } catch (error) {
    summary.ok = false;
    summary.error = error instanceof Error ? error.message : String(error);

    return summary;
  }

  for (const item of queue) {
    const { sourceAudioKey, trackId } = item;

    if (!trackId || !sourceAudioKey) {
      summary.skipped += 1;
      continue;
    }

    const dir = deps.mkWorkdir();

    try {
      // The REFERENCE first: no reference means no R2 GET is needed at all — the verdict is
      // already `no-preview`, and the captured bytes would be pulled for nothing.
      //
      // TWO RUNGS, TWO TRUST LEVELS (docs/the-ear.md § Wrong audio):
      //   - an ISRC row resolves the ISRC-exact preview (the trusted rung) — a mismatch against it
      //     is trustworthy and the server may rewind on it;
      //   - an ISRC-NULL row resolves a TITLE+ARTIST reference (the second rung) — LOWER trust, so
      //     it may only ever CONFIRM the capture. A mismatch against it is mapped to the honest
      //     abstain (`no-preview` → `unverified`), NEVER a `mismatch` verdict, so a wrong reference
      //     can never quarantine good audio. Precision over recall.
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
          // The R2 read failed (a dead object, a transient error). Not a verdict — skip, and the
          // row stays queued for the next tick.
          deps.log(`${trackId}: capture read failed — skipped`);
          summary.skipped += 1;
          continue;
        }

        const raw = deriveVerdict(referenceFp, deps.fingerprintFile(capturePath));

        if (raw === null) {
          // fpcalc failed on the captured bytes — a decode problem, never a stamp.
          deps.log(`${trackId}: capture fingerprint failed — skipped`);
          summary.skipped += 1;
          continue;
        }

        if (raw === "mismatch" && !trusted) {
          // A LOW-TRUST reference never condemns good audio: record the fuzzy mismatch distinctly
          // and abstain. Left `unverified`, terminally stamped, never re-tried, never quarantined.
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
      } else {
        // `not-captured` (a race — the row changed under us). Counted as verified work either way.
        deps.log(`${trackId}: nothing to verify anymore (${action})`);
      }
    } catch (error) {
      // One row's failure never aborts the tick (the capture-sweep discipline).
      deps.log(`${trackId}: ${error instanceof Error ? error.message : String(error)}`);
      summary.skipped += 1;
    } finally {
      deps.rmWorkdir(dir);
    }
  }

  return summary;
}

// ── MIRROR of the S3 GET signer in embed-batch.ts (box scripts can't import the workspace;
// keep in step with apps/web/src/lib/server/aws-sigv4.ts) ─────────────────────────────────

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

// ── The real (box-side) effects ───────────────────────────────────────────────

const R2_ENDPOINT = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

async function fetchVerifyQueue(limit: number): Promise<VerifyWorkItem[]> {
  const url = `${API_BASE_URL}/api/v1/admin/catalogue/captures/unverified?limit=${limit}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(
      `verify queue read failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }

  const body = (await res.json()) as { tracks?: VerifyWorkItem[] };

  return Array.isArray(body.tracks) ? body.tracks : [];
}

/** GET the captured full song from the private bucket into a scratch file (key used AS STORED). */
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

/** Probe for the fpcalc binary — the honest-degrade gate (see the header). */
export function fpcalcAvailable(bin: string = FPCALC_BIN): boolean {
  try {
    const result = spawnSync(bin, ["-version"], { encoding: "utf8", timeout: 10_000 });

    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const started = Date.now();

  if (!API_TOKEN) {
    console.log(JSON.stringify({ ok: false, reason: "missing_api_token" }));
    process.exit(1);
  }
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    console.log(JSON.stringify({ ok: false, reason: "missing_r2_credentials" }));
    process.exit(1);
  }

  // DEGRADE HONESTLY: no fpcalc → no stamps, no crash. The rows stay queued for the tick after
  // the rebake lands the binary. `ok: true` — an absent prerequisite is a known state, not a
  // failure the /status prober should page on.
  if (!fpcalcAvailable()) {
    log("fpcalc is not on PATH — the image needs the chromaprint rebake; nothing verified");
    console.log(JSON.stringify({ ok: true, reason: "fpcalc_missing", verified: 0 }));

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
    console.log(JSON.stringify({ error: message, ok: false, reason: "verify_failed" }));
    process.exit(1);
  });
}
