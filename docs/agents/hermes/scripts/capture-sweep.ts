#!/usr/bin/env bun
// capture-sweep.ts — the bun orchestrator behind the full-song CAPTURE sweep
// (`fluncle-capture`), scheduled by a rave-02 HOST systemd timer (../capture-timer/), not
// a Hermes gateway cron (a proxied yt-dlp fetch has an unbounded tail that would starve
// the 5-min sweeps). For each track still needing a capture — a certified FINDING or, once
// the operator opens the budget, an uncertified CATALOGUE row — it downloads the full song
// ONCE (yt-dlp → a YouTube match, through a residential proxy on a per-track STICKY
// session), duration-guards the match against the track's Spotify length, stores the
// bytes in the PRIVATE `fluncle-source-audio` R2 bucket (a finding under `<logId>/…`, a
// catalogue row under `catalogue/<trackId>/…`), and writes the key + status back via the
// agent-tier `update_track` op. It is a NON-BLOCKING parallel side-channel: it never gates
// the enrich/embed queues (docs/track-lifecycle.md).
//
// LIVE-INTENT. Version-controlled source; the repo is canonical and the box is a deploy
// target (fluncle-hermes-operator skill). Invoked by the bash wrapper (capture-sweep.sh)
// the host timer `docker exec`s on a schedule — see that file's header for the wire-up and
// ../capture-timer/README.md for the operator runbook.
//
// ── THIS SWEEP HAS NO BUDGET OF ITS OWN, AND THAT IS DELIBERATE ──────────────────────
// Capture is the one thing Fluncle does that bills per unit of work, so it has a BUDGET and a
// KILL SWITCH — and both live on the SERVER, in the queue, not here (the capture budget:
// apps/web/src/lib/server/capture-budget.ts, enforced in track-work.ts's `listTrackWork`).
//
// A brake in this file would be the wrong brake. This script is BAKED onto the box, so
// changing it is a re-bake rather than a flip; and it is only one client of the queue — the
// CLI is another, and the next sweep nobody has written yet is a third. Putting the brake at
// the queue means every client obeys it, and the operator stops the spend with one settings
// flip and no deploy. So this sweep's only budget duty is to be an HONEST METER: it stamps
// `sourceAudioAttemptedAt` on EVERY terminal outcome (done | unmatched | failed — each one was
// a billed proxy request) and `sourceAudioBytes` on a success, which is the only place a
// file's real size is ever knowable. The server does the deciding; this reports the spending.
//
// THE QUEUE IT READS: `list_track_work?kind=capture&scope=all` (docs/gpu-batch-embed.md), the
// CATALOGUE-AWARE worklist — NOT the old findings-only `captureQueue=true` admin list, which
// drove through the FINDING JOIN and so was structurally blind to a catalogue row. `kind=capture`
// serves both halves in the order the metered budget should be spent: certified findings FIRST
// (the archive can never be starved), then `capture_priority` DESC (the Ear's ladder —
// logged-artist > label-with-a-finding > enabled-seed-label; an operator-DISABLED label is
// tier −1 and excluded by SQL predicate, never bought). Same URL trick embed-sweep.ts uses: a
// DIRECT HTTP read (pin-independent), the WRITE-BACK still on the PATCH path below.
//
// THE BRAKE IS AT THE QUEUE, NOT HERE (apps/web/src/lib/server/{track-work,capture-budget}.ts).
// `list_track_work` consults the catalogue capture budget BEFORE it selects the worklist, and
// when that budget is shut — its DEFAULT-DENY state, the shipped default — it NARROWS the
// capture scope to the findings, never to empty. So with the brake paused this sweep sees EXACTLY
// the findings it saw on the old queue, in newest-first order, and behaves byte-for-byte as it
// did; the catalogue half lights up only once the operator opens the budget deliberately (one
// `settings` flip, no re-bake). This sweep never re-implements the brake; a brake in a baked box
// script would be re-bakeable, bypassable, and one `curl` away from irrelevant.
//
// CERTIFICATION RAIL (docs/gpu-batch-embed.md). A catalogue row is a MEASUREMENT target: the
// capture side-channel columns (captureStatus, sourceAudio*) are accepted on it, but a
// certification field is not. So the capture→enrich re-derive (`enrichmentStatus = 'pending'`)
// is written for CERTIFIED findings ONLY — `enrichment_status` lives on the certification, and
// the server would 409 an uncertified write of one. When the brake is paused every row is a
// finding, so this gate changes nothing about today's behaviour.
//
// SELF-CONTAINED by necessity: box scripts can't import the workspace. The S3 signer
// MIRRORS apps/web/src/lib/server/aws-sigv4.ts (unit-tested there via aws-sigv4.test.ts)
// exactly like backup-sweep.ts — keep them in step. The pure helpers below
// (buildStickyProxyUrl / durationWithinTolerance / buildSourceAudioKey / pickCandidate /
// needsReenrichAfterCapture) are exported + unit-tested in capture-sweep.test.ts; `main()` is
// guarded behind `import.meta.main` so importing this module for the tests is side-effect
// free (it does not spawn yt-dlp or touch R2).
//
// THE CAPTURE MECHANISM (validated end-to-end on rave-02, 2026-07-07):
//   - rave-02 is a datacenter IP → YouTube bot-walls it; a DataImpulse residential proxy
//     resolves it (the exit IP reads as a real ISP).
//   - The proxy session must be STICKY per track: `__sessid.<logId>` on the username pins
//     one exit IP for the whole download, or googlevideo 403s the media-bytes fetch (the
//     CDN IP-locks the URL to the player-JSON IP). A rotating session fails.
//   - The match is a title/artist YouTube result, NOT Spotify's master, so a wrong-VERSION
//     match (remix/live/sped-up/nightcore/radio-edit) is the real failure mode — the
//     DURATION GUARD (accept only within tolerance of the finding's durationMs) + a
//     de-rank of remix/live markers catch it → `unmatched` on a mismatch.
//   - On a 403 that survives the sticky session, retry the download once with
//     `--extractor-args youtube:player_client=tv,web_safari` before marking `failed`.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Config (env; the shared ~/.fluncle-secrets.env supplies the secrets on the box) ──

const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";

// The residential proxy (DataImpulse in v1; the cron is proxy-agnostic — a swap touches
// only these creds + the session-string builder). Read from env, never hardcoded.
const PROXY_HOST = process.env.FLUNCLE_YTDLP_PROXY_HOST ?? "";
const PROXY_PORT = process.env.FLUNCLE_YTDLP_PROXY_PORT ?? "";
const PROXY_USERNAME = process.env.FLUNCLE_YTDLP_PROXY_USERNAME ?? "";
const PROXY_PASSWORD = process.env.FLUNCLE_YTDLP_PROXY_PASSWORD ?? "";

// A dedicated, least-privilege R2 token: Object Read & Write on the PRIVATE
// fluncle-source-audio bucket ONLY (never fluncle-videos, which is world-served).
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID ?? "";
const R2_ACCESS_KEY_ID = process.env.FLUNCLE_SOURCE_AUDIO_R2_ACCESS_KEY_ID ?? "";
const R2_SECRET_ACCESS_KEY = process.env.FLUNCLE_SOURCE_AUDIO_R2_SECRET_ACCESS_KEY ?? "";
const R2_BUCKET = process.env.FLUNCLE_SOURCE_AUDIO_R2_BUCKET ?? "fluncle-source-audio";

// yt-dlp / ffprobe from PATH (both are a box deploy prereq — see cron/README.md).
const YT_DLP_BIN = process.env.YT_DLP_BIN ?? "yt-dlp";
const FFPROBE_BIN = process.env.FFPROBE_BIN ?? "ffprobe";

// How many queue rows to read, and how many to actually process per tick. The queue is
// newest-first, so a fresh add is always in the first page and jumps the backfill.
const QUEUE_LIMIT = Number(process.env.FLUNCLE_CAPTURE_QUEUE_LIMIT ?? "8");
const BATCH_CAP = Number(process.env.FLUNCLE_CAPTURE_BATCH_CAP ?? "4");

// Duration guard: accept a candidate whose length is within max(±3s, ±3%) of the
// finding's Spotify duration. Duration catches the gross mismatches (edits/speed changes);
// a same-length remaster is fine (Unit 4's shape-normalized log-mel tolerates it).
const TOLERANCE_SEC = Number(process.env.FLUNCLE_CAPTURE_TOLERANCE_SEC ?? "3");
const TOLERANCE_PCT = Number(process.env.FLUNCLE_CAPTURE_TOLERANCE_PCT ?? "0.03");
// A candidate from a TRUSTED channel (the finding's label, a curated aggregator, or the
// artist's own channel) is the right track even when its length runs OVER the master —
// label/artist video uploads carry an intro sting + outro card the streaming master lacks.
// So for trusted channels the guard widens ASYMMETRICALLY: stay tight below (a shorter
// upload is a radio edit/snippet, a different arrangement), but allow up to this much
// padding above. Bounded so a trusted channel's hour-long DJ set (same title) is still
// rejected. See the "1991 - If Only" case (191s master, 214s label video).
const TRUSTED_PAD_SEC = Number(process.env.FLUNCLE_CAPTURE_TRUSTED_PAD_SEC ?? "60");
// How many ranked candidates to attempt per finding before giving up: the top hit is
// sometimes DRM-locked or bot-walled, and a different upload of the same track downloads
// fine, so walk down the ranked list (fast-failing errors keep the cost low).
const DOWNLOAD_ATTEMPTS = Number(process.env.FLUNCLE_CAPTURE_DOWNLOAD_ATTEMPTS ?? "3");

const YT_SEARCH_TIMEOUT_MS = 60_000;
const YT_DOWNLOAD_TIMEOUT_MS = 180_000;

const log = (message: string) => console.error(`[capture-sweep] ${message}`);

// ── Pure helpers (exported for capture-sweep.test.ts) ─────────────────────────

/** A row as the capture worklist (`GET /api/admin/tracks/work?kind=capture`) returns it. */
export type CaptureFinding = {
  // Which audio class BPM/key were last analyzed from ("full" the captured song | "preview"
  // a 30s preview). Absent = a legacy row analyzed before the provenance column (treated as
  // preview-grade). The capture worklist surfaces it (RFC bpm-key-accuracy); the re-enrich
  // predicate reads it to close the capture→enrich race — a finding whose enrich tick fired
  // BEFORE its capture landed was analyzed from the preview, and this re-queues it.
  analyzedFrom?: "preview" | "full";
  artists?: string[];
  // The artist's own YouTube channel id(s), from `artist_socials` (attached by the capture
  // worklist server-side). When a candidate is on one of these it is the artist's OWN upload →
  // the strongest trust signal. Absent when the artists have no `/channel/UC…` link, in which
  // case the label/allowlist signals carry the trust classification.
  artistYoutubeChannelIds?: string[];
  bpm?: number | null;
  // True when a `findings` row exists — the certification rail's flag. FALSE for a catalogue
  // track (visible only once the operator opens the budget). The re-derive write-back gates on
  // it: `enrichment_status` is a certification column and the server 409s an uncertified write.
  certified?: boolean;
  durationMs?: number;
  // The release label (already on the admin list DTO). A YouTube candidate whose channel
  // name equals the label is almost certainly the correct upload — it lets the duration
  // guard relax for that candidate. For self-released tracks the label IS the artist name,
  // so this doubles as an artist-channel signal before `artist_socials` lands.
  label?: string;
  logId?: string;
  // The prior consecutive-failure count (the admin list DTO surfaces it when non-zero),
  // read so the failure bump ACCUMULATES — the queue's failure-cap backoff depends on it.
  sourceAudioFailures?: number;
  title?: string;
  trackId: string;
};

/**
 * Build the STICKY residential-proxy URL for one track: append `__sessid.<sessionId>` to
 * the username (pins one exit IP for the whole download — a rotating session 403s the
 * media-bytes fetch), then url-encode the (username+suffix) and password so a credential
 * containing `@`/`:`/`/` can't corrupt the authority. The session id is the track's
 * identity — a finding's Log ID, or the raw `track_id` for a catalogue row — SANITIZED to
 * the alnum + `.` charset a Log ID already uses (a crawler-minted `mb_<uuid>` carries `_`
 * and `-`, which the proxy vendor's session parser has never been proven to accept).
 * Stickiness only needs determinism per track, so stripping is safe.
 */
export function buildStickyProxyUrl(options: {
  host: string;
  password: string;
  port: string;
  sessionId: string;
  username: string;
}): string {
  const session = options.sessionId.replace(/[^0-9A-Za-z.]/g, "");
  const userWithSession = `${options.username}__sessid.${session}`;
  const user = encodeURIComponent(userWithSession);
  const pass = encodeURIComponent(options.password);

  return `http://${user}:${pass}@${options.host}:${options.port}`;
}

/**
 * The duration match-guard: accept a candidate only if its length is within
 * max(toleranceSec, targetSec × tolerancePct) of the finding's Spotify duration. Returns
 * false for a missing/zero target (we can't guard without a reference length).
 */
export function durationWithinTolerance(
  candidateSec: number,
  targetMs: number | undefined,
  options: { tolerancePct: number; toleranceSec: number } = {
    tolerancePct: TOLERANCE_PCT,
    toleranceSec: TOLERANCE_SEC,
  },
): boolean {
  if (!Number.isFinite(candidateSec) || candidateSec <= 0) {
    return false;
  }

  if (!targetMs || !Number.isFinite(targetMs) || targetMs <= 0) {
    return false;
  }

  const targetSec = targetMs / 1000;
  const allowed = Math.max(options.toleranceSec, targetSec * options.tolerancePct);

  return Math.abs(candidateSec - targetSec) <= allowed;
}

/**
 * The R2 key for a captured full song. A FINDING keys under its coordinate,
 * `<logId>/<sha256>.<ext>`; a CATALOGUE row (no coordinate exists) under
 * `catalogue/<trackId>/<sha256>.<ext>` — a distinct, self-describing namespace that can
 * never collide with a Log ID. Certification later does NOT re-key: `source_audio_key`
 * is the pointer of record, wherever the object sits. (The bucket is dedicated to source
 * audio, so no further prefix.)
 */
export function buildSourceAudioKey(keyRoot: string, sha256Hex: string, ext: string): string {
  const cleanExt = ext.replace(/^\./, "").toLowerCase();

  return `${keyRoot}/${sha256Hex}.${cleanExt}`;
}

// Title markers that signal a WRONG version (a same-length remix/edit slips the duration
// guard, so de-rank these before the guard even runs).
const WRONG_VERSION_MARKERS =
  /\b(remix|bootleg|live|sped[\s-]?up|slowed|nightcore|8d audio|cover|karaoke|instrumental|mashup|edit|rework|vip mix)\b/i;
const OFFICIAL_MARKERS = /(-\s*topic\b|official audio|official video|official music video)/i;

/**
 * Normalize a YouTube channel name (or a release label) to a comparison key: lowercase, map
 * `&`→`and`, strip the boilerplate suffixes labels tack on (records/recordings/music/audio/
 * "drum & bass"/dnb/official/tv/…), then drop every non-alphanumeric. So "UKF Drum & Bass",
 * "Hospital Records" and a label field of "Hospital" all reduce to a stable comparable token.
 */
export function normalizeChannelName(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(
      /\b(records?|recordings?|music|audio|drum\s*(?:and|n)?\s*bass|dnb|official|channel|tv|ltd)\b/g,
      "",
    )
    .replace(/[^a-z0-9]+/g, "");
}

// Curated trusted D&B channels: labels + aggregators that release/host the real master and
// do NOT upload a wrong VERSION under a bare "Artist - Title". A clean-title hit on one of
// these (or on a channel named like the finding's label, or the artist's own channel) lets
// the duration guard relax to allow the video intro/outro padding. Matched by normalized
// channel NAME (resilient to new uploads) OR stable channel_id where known. This is domain
// curation — extend it with the labels/aggregators you trust (verified channels only).
const TRUSTED_CHANNEL_NAMES = new Set(
  [
    "UKF",
    "UKF Drum & Bass",
    "Liquicity",
    "Liquicity Records",
    "Hospital Records",
    "Hospitality",
    "Shogun Audio",
    "RAM Records",
    "Critical Music",
    "Blackout Music",
    "Vision Recordings",
    "Overview Music",
    "Korsakov Music",
    "Flashover Recordings",
    "Sofa Sound",
    "Metalheadz",
    "V Recordings",
    "Hospital Records TV",
    "Monstercat",
    "Monstercat Uncaged",
  ].map(normalizeChannelName),
);
const TRUSTED_CHANNEL_IDS = new Set<string>([
  "UCr8oc-LOaApCXWLjL7vdsgw", // UKF Drum & Bass (verified via box probe 2026-07-07)
]);

// 0 = untrusted, 1 = verified-only (a soft tiebreak, does NOT relax duration), 2 = trusted
// (label match / curated allowlist / the artist's own channel — relaxes the duration guard).
export type TrustTier = 0 | 1 | 2;

/**
 * Classify how much a candidate's CHANNEL can be trusted for this finding. Tier 2 (trusted)
 * = the candidate is the artist's own upload (channel_id in `artistYoutubeChannelIds`), on a
 * curated aggregator/label, or on a channel whose name equals the finding's label. Tier 1 =
 * merely YouTube-verified (a weak corroborating signal). Tier 0 = anything else.
 */
export function classifyChannelTrust(
  candidate: YtCandidate,
  context: { artistYoutubeChannelIds?: readonly string[]; label?: string },
): TrustTier {
  const channelId = candidate.channelId ?? "";
  const channelKey = normalizeChannelName(candidate.channel ?? "");

  if (channelId && context.artistYoutubeChannelIds?.includes(channelId)) {
    return 2;
  }
  if (channelId && TRUSTED_CHANNEL_IDS.has(channelId)) {
    return 2;
  }
  if (channelKey && TRUSTED_CHANNEL_NAMES.has(channelKey)) {
    return 2;
  }
  const labelKey = normalizeChannelName(context.label ?? "");
  if (labelKey && channelKey && labelKey === channelKey) {
    return 2;
  }
  return candidate.verified ? 1 : 0;
}

/**
 * Whether a candidate's length is acceptable given its channel trust. Untrusted candidates
 * take the strict symmetric guard (`durationWithinTolerance`). Trusted candidates (tier 2)
 * take an ASYMMETRIC guard: tight below (no radio edit / snippet) but padded above by
 * `trustedPadSec` (the label/artist video's intro sting + outro card) — bounded so an
 * hour-long DJ set on the same trusted channel is still rejected.
 */
export function durationAcceptable(
  candidateSec: number,
  targetMs: number | undefined,
  trust: TrustTier,
  options: { tolerancePct: number; toleranceSec: number; trustedPadSec: number } = {
    tolerancePct: TOLERANCE_PCT,
    toleranceSec: TOLERANCE_SEC,
    trustedPadSec: TRUSTED_PAD_SEC,
  },
): boolean {
  if (trust < 2) {
    return durationWithinTolerance(candidateSec, targetMs, options);
  }
  if (!Number.isFinite(candidateSec) || candidateSec <= 0) {
    return false;
  }
  if (!targetMs || !Number.isFinite(targetMs) || targetMs <= 0) {
    return false;
  }
  const targetSec = targetMs / 1000;
  return (
    candidateSec >= targetSec - options.toleranceSec &&
    candidateSec <= targetSec + options.trustedPadSec
  );
}

export type YtCandidate = {
  channel?: string;
  channelId?: string;
  durationSec: number;
  id: string;
  title: string;
  verified?: boolean;
};

/**
 * Pick the best YouTube candidate for a finding. Keep only candidates whose duration passes
 * the trust-aware guard (trusted channels tolerate video padding), then rank: CLEAN titles
 * before wrong-version markers (a trusted remix never beats an untrusted clean master), then
 * higher channel trust (the label/artist upload over a random re-host, even when the re-host
 * is closer in length — identity safety beats a few seconds of fidelity), then official/
 * `- Topic`, then verified, then closest duration. Returns the pick WITH its trust tier (the
 * caller re-uses it for the post-download length re-check) or null → the finding is `unmatched`.
 */
export function rankCandidates(
  candidates: readonly YtCandidate[],
  context: { artistYoutubeChannelIds?: readonly string[]; durationMs?: number; label?: string },
  options: { tolerancePct: number; toleranceSec: number; trustedPadSec: number } = {
    tolerancePct: TOLERANCE_PCT,
    toleranceSec: TOLERANCE_SEC,
    trustedPadSec: TRUSTED_PAD_SEC,
  },
): { candidate: YtCandidate; trust: TrustTier }[] {
  const targetSec = context.durationMs && context.durationMs > 0 ? context.durationMs / 1000 : 0;
  const scored = candidates
    .map((candidate) => ({ candidate, trust: classifyChannelTrust(candidate, context) }))
    .filter(({ candidate, trust }) =>
      durationAcceptable(candidate.durationSec, context.durationMs, trust, options),
    )
    .map(({ candidate, trust }) => ({
      candidate,
      clean: WRONG_VERSION_MARKERS.test(candidate.title) ? 0 : 1,
      delta: Math.abs(candidate.durationSec - targetSec),
      official: OFFICIAL_MARKERS.test(candidate.title) ? 1 : 0,
      trust,
      verified: candidate.verified ? 1 : 0,
    }));

  scored.sort(
    (a, b) =>
      b.clean - a.clean ||
      b.trust - a.trust ||
      b.official - a.official ||
      b.verified - a.verified ||
      a.delta - b.delta,
  );

  return scored.map(({ candidate, trust }) => ({ candidate, trust }));
}

/**
 * The single best candidate (rank 1) or null → `unmatched`. Thin wrapper over
 * `rankCandidates`; the sweep itself walks the ranked list so it can fall through a
 * DRM-locked or bot-walled top hit to the next-best downloadable one.
 */
export function pickCandidate(
  candidates: readonly YtCandidate[],
  context: { artistYoutubeChannelIds?: readonly string[]; durationMs?: number; label?: string },
  options?: { tolerancePct: number; toleranceSec: number; trustedPadSec: number },
): { candidate: YtCandidate; trust: TrustTier } | null {
  return rankCandidates(candidates, context, options)[0] ?? null;
}

/** Whether a stored BPM is genuinely missing (null/absent/non-finite/≤0). */
export function bpmIsMissing(bpm: number | null | undefined): boolean {
  return bpm == null || !Number.isFinite(bpm) || bpm <= 0;
}

/**
 * Whether a just-landed capture should ALSO re-queue enrichment (clobber-safe): when the
 * BPM is genuinely missing, OR the row was NOT analyzed from FULL audio (`analyzedFrom !==
 * "full"`, which includes a NULL legacy row — treated as preview-grade). This closes the
 * capture→enrich RACE: capture and enrichment are independent self-healing queues, so a
 * finding whose enrich tick fired BEFORE its capture landed was analyzed from the 30s
 * preview, permanently — re-queueing it lets the next enrich tick re-derive BPM/key from the
 * full song now on file. Enrichment is itself clobber-safe (it re-writes, it doesn't corrupt
 * a good value), and a preview-grade row re-analyzed from full audio is a strict upgrade.
 * A REAL bpm on an already-full-analyzed row is left untouched (the predicate is false).
 */
export function needsReenrichAfterCapture(
  bpm: number | null | undefined,
  analyzedFrom: "preview" | "full" | undefined,
): boolean {
  return bpmIsMissing(bpm) || analyzedFrom !== "full";
}

/**
 * Whether a just-landed capture should re-queue enrichment, gated by CERTIFICATION. Re-queueing
 * writes `enrichmentStatus = "pending"`, and `enrichment_status` is a CERTIFICATION column: the
 * server accepts it only on a certified finding and 409s an uncertified (catalogue) write of one
 * (the certification rail, docs/gpu-batch-embed.md). So an uncertified row is NEVER re-queued
 * here — its enrichment is not a thing that exists. A certified finding falls through to
 * `needsReenrichAfterCapture`, unchanged. With the capture brake paused every row is a finding,
 * so this gate is a no-op against today's behaviour and only matters once the catalogue lights up.
 *
 * `certified === undefined` is treated as NOT certified: the worklist DTO always carries the
 * flag, so an absent value is a malformed row, and the safe reading of "is this a finding?" when
 * unsure is no — never write a certification field on a row you cannot confirm is certified.
 */
export function shouldReenrichAfterCapture(
  certified: boolean | undefined,
  bpm: number | null | undefined,
  analyzedFrom: "preview" | "full" | undefined,
): boolean {
  return certified === true && needsReenrichAfterCapture(bpm, analyzedFrom);
}

/** Map a file extension to an audio content-type for the R2 PUT. */
export function contentTypeForExt(ext: string): string {
  const cleanExt = ext.replace(/^\./, "").toLowerCase();
  const map: Record<string, string> = {
    aac: "audio/aac",
    flac: "audio/flac",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    mp4: "audio/mp4",
    oga: "audio/ogg",
    ogg: "audio/ogg",
    opus: "audio/opus",
    wav: "audio/wav",
    webm: "audio/webm",
  };

  return map[cleanExt] ?? "application/octet-stream";
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

// ── R2 (S3 API) put ────────────────────────────────────────────────────────

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

// ── Admin API (direct HTTP — pin-independent, not the baked CLI) ──────────────

async function fetchCaptureQueue(): Promise<CaptureFinding[]> {
  // The CATALOGUE-AWARE worklist (docs/gpu-batch-embed.md), NOT the old findings-only
  // `captureQueue=true` admin list. `kind=capture&scope=all` serves both halves in the
  // metered-budget drain order (certified first, then the Ear's capture-priority ladder);
  // the budget's brake — consulted server-side BEFORE the worklist is selected — narrows the
  // scope to the findings while it is shut (its default), so a paused brake reads exactly the
  // findings the old queue did. No `order` param: this queue's order is fixed by the budget.
  const url = `${API_BASE_URL}/api/admin/tracks/work?kind=capture&scope=all&limit=${QUEUE_LIMIT}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(
      `capture queue read failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
  const body = (await res.json()) as { tracks?: CaptureFinding[] };
  return Array.isArray(body.tracks) ? body.tracks : [];
}

async function patchTrack(trackId: string, update: Record<string, unknown>): Promise<void> {
  const url = `${API_BASE_URL}/api/admin/tracks/${encodeURIComponent(trackId)}`;
  const res = await fetch(url, {
    body: JSON.stringify(update),
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "PATCH",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(
      `update_track ${trackId} failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
}

// ── yt-dlp + ffprobe (subprocess) ────────────────────────────────────────────

function runYtSearch(proxyUrl: string, query: string): YtCandidate[] {
  const result = spawnSync(
    YT_DLP_BIN,
    [
      "--proxy",
      proxyUrl,
      "--socket-timeout",
      "30",
      "--no-warnings",
      // Tab-separated so title (which may itself contain tabs) stays LAST. Channel name +
      // id + verified flag drive the trust classification (channel-trust matching); yt-dlp
      // prints "NA" for an absent field.
      "--print",
      "%(duration)s\t%(id)s\t%(channel)s\t%(channel_id)s\t%(channel_is_verified)s\t%(title)s",
      `ytsearch5:${query}`,
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: YT_SEARCH_TIMEOUT_MS },
  );

  if (result.status !== 0) {
    throw new Error(`yt-dlp search failed: ${(result.stderr || "").slice(0, 200)}`);
  }

  const naToUndefined = (value?: string) => (value && value !== "NA" ? value : undefined);
  const candidates: YtCandidate[] = [];
  for (const line of (result.stdout || "").split("\n")) {
    const [durationRaw, id, channelRaw, channelIdRaw, verifiedRaw, ...titleParts] =
      line.split("\t");
    if (!id) {
      continue;
    }
    candidates.push({
      channel: naToUndefined(channelRaw),
      channelId: naToUndefined(channelIdRaw),
      durationSec: Number(durationRaw),
      id,
      title: titleParts.join("\t"),
      verified: verifiedRaw === "True",
    });
  }
  return candidates;
}

/** Download one video id's best audio into `dir`. Returns the produced file path + ext. */
function runYtDownload(
  proxyUrl: string,
  videoId: string,
  dir: string,
  playerClientFallback: boolean,
): { ext: string; path: string } {
  const base = join(dir, "audio");
  const args = [
    "--proxy",
    proxyUrl,
    "--socket-timeout",
    "30",
    "--no-warnings",
    "--no-playlist",
    "-f",
    "bestaudio",
    "-o",
    `${base}.%(ext)s`,
  ];
  if (playerClientFallback) {
    args.push("--extractor-args", "youtube:player_client=tv,web_safari");
  }
  args.push(`https://www.youtube.com/watch?v=${videoId}`);

  const result = spawnSync(YT_DLP_BIN, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: YT_DOWNLOAD_TIMEOUT_MS,
  });

  const stderr = result.stderr || "";
  if (result.status !== 0) {
    const err = new Error(`yt-dlp download failed: ${stderr.slice(0, 200)}`);
    (err as { is403?: boolean }).is403 = /HTTP Error 403|status code 403|\b403\b/.test(stderr);
    // DRM-locked or bot-walled: this specific VIDEO can't be pulled, but another candidate
    // for the same finding often can → the caller falls through to the next-ranked one.
    (err as { isRecoverable?: boolean }).isRecoverable =
      /DRM protected|Sign in to confirm|not a bot/i.test(stderr);
    throw err;
  }

  const produced = readdirSync(dir).find((entry) => entry.startsWith("audio."));
  if (!produced) {
    throw new Error("yt-dlp produced no output file");
  }
  const ext = produced.slice(produced.indexOf(".") + 1);
  return { ext, path: join(dir, produced) };
}

/** ffprobe the file's real duration in seconds (belt-and-suspenders vs the search value). */
function probeDurationSec(filePath: string): number {
  const result = spawnSync(
    FFPROBE_BIN,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (result.status !== 0) {
    throw new Error(`ffprobe failed: ${(result.stderr || "").slice(0, 200)}`);
  }
  return Number((result.stdout || "").trim());
}

// ── Per-finding capture ────────────────────────────────────────────────────

type FindingOutcome = "done" | "unmatched" | "failed" | "skipped";

async function captureFinding(finding: CaptureFinding): Promise<FindingOutcome> {
  const { logId, trackId } = finding;

  // A CERTIFIED row with no coordinate is the impossible case (the queue requires
  // `log_id` on the finding half) — defensive skip, exactly as before. An UNCERTIFIED
  // (catalogue) row has no coordinate BY CONSTRUCTION and captures under its `track_id`
  // instead: the queue serves it deliberately (the Ear's ladder, behind the budget brake),
  // so skipping it here would silently defeat the whole catalogue half — which is exactly
  // the bug this guard once was (every catalogue row skipped, unstamped, re-picked forever).
  if (!logId && finding.certified !== false) {
    return "skipped";
  }

  // The track's identity for everything that needs one below: the sticky proxy session
  // and the R2 key root. A finding is its coordinate; a catalogue row is its track id.
  const keyRoot = logId ?? `catalogue/${trackId}`;

  const artists = (finding.artists ?? []).join(" ");
  const query = `${artists} ${finding.title ?? ""}`.trim();
  const proxyUrl = buildStickyProxyUrl({
    host: PROXY_HOST,
    password: PROXY_PASSWORD,
    port: PROXY_PORT,
    sessionId: logId ?? trackId,
    username: PROXY_USERNAME,
  });

  const dir = mkdtempSync(join(tmpdir(), "fluncle-capture-"));

  try {
    // Search candidates WITHOUT downloading, then RANK them whose length passes the
    // trust-aware guard (a trusted label/artist channel tolerates video intro/outro padding;
    // wrong-version titles de-rank) — avoids downloading a wrong-length file.
    const candidates = runYtSearch(proxyUrl, query);
    const ranked = rankCandidates(candidates, {
      artistYoutubeChannelIds: finding.artistYoutubeChannelIds,
      durationMs: finding.durationMs,
      label: finding.label,
    });

    if (ranked.length === 0) {
      // `sourceAudioAttemptedAt` on an UNMATCHED too: it was a billed proxy request (a search),
      // and the capture budget's ledger counts attempts rather than successes — a day of
      // unmatched rows still spends money, and a meter that could not see that would read zero
      // while the bill climbed. See apps/web/src/lib/server/capture-budget.ts.
      await patchTrack(trackId, {
        captureStatus: "unmatched",
        sourceAudioAttemptedAt: new Date().toISOString(),
      });
      return "unmatched";
    }

    // Walk the ranked candidates: download the best one, but fall through a DRM-locked or
    // bot-walled hit to the next-ranked candidate (a different upload of the same track is
    // usually pullable). On a 403 surviving the sticky session, retry once with the
    // tv/web_safari player clients first. A non-recoverable error aborts (→ `failed`).
    let downloaded: { ext: string; path: string } | undefined;
    let chosen: { candidate: YtCandidate; trust: TrustTier } | undefined;
    let lastError: unknown;
    for (const candidate of ranked.slice(0, DOWNLOAD_ATTEMPTS)) {
      try {
        try {
          downloaded = runYtDownload(proxyUrl, candidate.candidate.id, dir, false);
        } catch (error) {
          if ((error as { is403?: boolean }).is403) {
            downloaded = runYtDownload(proxyUrl, candidate.candidate.id, dir, true);
          } else {
            throw error;
          }
        }
        chosen = candidate;
        break;
      } catch (error) {
        lastError = error;
        if ((error as { isRecoverable?: boolean }).isRecoverable) {
          log(`candidate ${candidate.candidate.id} unusable (DRM/bot-wall) — trying next`);
          continue;
        }
        throw error;
      }
    }

    if (!downloaded || !chosen) {
      throw lastError ?? new Error("no downloadable candidate");
    }

    // Belt-and-suspenders: confirm the REAL downloaded duration passes the guard too (the
    // search value can lie / point at a different manifest). Re-use the chosen candidate's
    // trust tier so a trusted padded upload isn't rejected here after passing the pick.
    const realDurationSec = probeDurationSec(downloaded.path);
    if (!durationAcceptable(realDurationSec, finding.durationMs, chosen.trust)) {
      // Unmatched AFTER a download — the most expensive miss there is (the bytes were pulled
      // through the metered proxy and then thrown away). It absolutely counts as an attempt.
      await patchTrack(trackId, {
        captureStatus: "unmatched",
        sourceAudioAttemptedAt: new Date().toISOString(),
      });
      return "unmatched";
    }

    const bytes = new Uint8Array(readFileSync(downloaded.path));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const key = buildSourceAudioKey(keyRoot, digest, downloaded.ext);

    await r2Put(key, bytes, contentTypeForExt(downloaded.ext));

    // Write back: the key + done + the captured stamp + THE METER. Clobber-safe enrichment
    // trigger — for a CERTIFIED finding, re-queue when the BPM is missing OR the row was analyzed
    // from a preview (not full audio), closing the capture→enrich race (see
    // shouldReenrichAfterCapture; a catalogue row has no enrichment to re-queue and is skipped).
    //
    // `sourceAudioBytes` is what the operator is actually billed for, and it is knowable only
    // HERE — the queue holds metadata, not media, so there is no size to consult before the
    // download. It is the whole reason the capture budget's byte cap is a between-batches
    // backstop rather than a pre-flight guarantee. `sourceAudioAttemptedAt` is stamped on the
    // success too (not only on failure): the budget's rolling-24h ledger is a range seek on
    // that column, so a success that did not stamp it would be a download the meter never saw.
    const now = new Date().toISOString();
    const update: Record<string, unknown> = {
      captureStatus: "done",
      sourceAudioAttemptedAt: now,
      sourceAudioBytes: bytes.byteLength,
      sourceAudioCapturedAt: now,
      sourceAudioKey: key,
    };
    if (shouldReenrichAfterCapture(finding.certified, finding.bpm, finding.analyzedFrom)) {
      update.enrichmentStatus = "pending";
    }
    await patchTrack(trackId, update);

    return "done";
  } catch (error) {
    // A yt-dlp / proxy / R2 error → failed (retriable under backoff). ACCUMULATE the
    // consecutive-failure count + stamp the attempt: the capture queue holds a `failed`
    // row out until `source_audio_attempted_at` is past the cooldown, and drops it once
    // the count hits the cap. The admin DTO surfaces the prior count (when non-zero), so
    // absent → 0 → a first failure lands 1, a second lands 2, … up to the cap.
    const priorFailures =
      typeof finding.sourceAudioFailures === "number" ? finding.sourceAudioFailures : 0;
    await patchTrack(trackId, {
      captureStatus: "failed",
      sourceAudioAttemptedAt: new Date().toISOString(),
      sourceAudioFailures: priorFailures + 1,
    }).catch((patchError: unknown) => {
      log(`failed to record failure for ${trackId}: ${String(patchError)}`);
    });
    log(
      `capture failed for ${logId ?? "catalogue"} (${trackId}): ${error instanceof Error ? error.message : String(error)}`,
    );
    return "failed";
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const started = Date.now();

  if (!API_TOKEN) {
    console.log(JSON.stringify({ ok: false, reason: "missing_api_token" }));
    process.exit(1);
  }
  if (!PROXY_HOST || !PROXY_PORT || !PROXY_USERNAME || !PROXY_PASSWORD) {
    console.log(JSON.stringify({ ok: false, reason: "missing_proxy_credentials" }));
    process.exit(1);
  }
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    console.log(JSON.stringify({ ok: false, reason: "missing_r2_credentials" }));
    process.exit(1);
  }

  const queue = await fetchCaptureQueue();
  const batch = queue.slice(0, Number.isFinite(BATCH_CAP) && BATCH_CAP > 0 ? BATCH_CAP : 4);

  const counts = { done: 0, failed: 0, skipped: 0, unmatched: 0 };

  for (const finding of batch) {
    // Catch per-finding: one failure must never abort the tick.
    try {
      const outcome = await captureFinding(finding);
      counts[outcome] += 1;
    } catch (error) {
      counts.failed += 1;
      log(
        `unexpected error on ${finding.trackId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(
    JSON.stringify({
      batch: batch.length,
      done: counts.done,
      elapsedMs: Date.now() - started,
      failed: counts.failed,
      ok: true,
      queueDepth: queue.length,
      skipped: counts.skipped,
      unmatched: counts.unmatched,
    }),
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log(`capture sweep failed: ${message}`);
    console.log(JSON.stringify({ error: message, ok: false, reason: "capture_failed" }));
    process.exit(1);
  });
}
