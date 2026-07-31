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
// needsReenrichAfterCapture / buildSearchQuery / isTopicChannel / classifyDownloadFailure /
// chooseDownloadRecovery) are exported + unit-tested in capture-sweep.test.ts, as are the
// bot-challenge meter's two logging seams (noteBotChallenge / logBotChallengeRecap), whose
// tests score their REAL stderr with the REAL /status strain detector; `main()` is
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
//   - FINDING the upload (the `unmatched`-rate fix, 2026-07-13). The primary search is
//     `<artists> <title>`, and the ranker PREFERS a YouTube auto-generated `<Artist> - Topic`
//     art-track: the label-delivered master, duration-exact and ISRC-tagged by construction, and
//     recognized by CHANNEL name (its title is the bare song, so the title-only official marker
//     misses it). And when the primary search returns ZERO RAW candidates — the over-constrained
//     multi-artist credit or the odd-punctuation title that found nothing — ONE de-constrained
//     fallback search (primary artist + a version-stripped title) is spent before declaring
//     `unmatched`. The fallback fires ONLY on zero raw results, never when candidates came back
//     and missed the guard (the song genuinely isn't there at that length, and a reshaped query
//     cannot conjure it): the cost ceiling is `FLUNCLE_CAPTURE_QUERY_VARIANTS` billed searches per
//     finding, and there is no loop. Neither change relaxes the duration guard or the gate below.
//   - And a wrong-SONG match (same artist/label, right length, different track — the 005.9.9L
//     defect) slips both, so every download passes THE FINGERPRINT GATE before storing: the
//     captured bytes Chromaprint-matched against the track's ISRC-resolved official preview
//     (docs/the-ear.md § Wrong audio; the matcher is fingerprint-match.ts, shared with the
//     verify-captures backfill). Match → stored + `capture_verification = 'preview-match'`;
//     mismatch → rejected + remembered in `source_audio_rejected`, next candidate; no
//     preview / no fpcalc → stored + `'unverified'` (the honest abstain, never a block).
//   - On a BOT CHALLENGE ("Sign in to confirm you're not a bot" — an IP-reputation verdict
//     on the proxy exit, which no client fallback clears), re-roll the sticky session ONCE
//     per run (`<id>.r1`, a fresh residential exit) and retry; search and download share
//     the one re-roll, and a run challenged on both exits leaves the rest to backoff.
//   - On a 403 that survives the sticky session, retry the download once with
//     `--extractor-args youtube:player_client=tv,web_safari` before marking `failed`. The
//     challenge is tested FIRST and the 403 match is ANCHORED (`HTTP Error 403` /
//     `status code 403`, never a bare `403`): a challenge stderr that also carries a 403 —
//     the missing-PO-token shape — belongs to the re-roll, not to a client fallback that
//     cannot clear an IP ruling.
//   - EVERY challenge is metered and logged, not just the one that triggers the re-roll, and
//     the tick's totals ride out in the JSON summary. See THE BOT-CHALLENGE METER below for
//     that and for the strain contract these lines owe /status.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// THE FINGERPRINT VERIFICATION GATE (docs/the-ear.md § Wrong audio) — the shared, pure matcher
// (also used by the historic backfill, verify-captures.ts) + the fpcalc/preview I/O helpers.
import {
  appendRejectedSource,
  fetchPreviewFingerprint,
  fpcalcFingerprint,
  parseRejectedSources,
  type RejectedSource,
  rejectedShas,
  rejectedVideoIds,
  slidingWindowMatch,
} from "./fingerprint-match";

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
// Bounded parallel captures within one tick. Each capture is dominated by the proxy download
// (~25-30s wall-clock, near-zero CPU), so 2-3 workers nearly multiply throughput; the SPEND
// governor stays the rolling-24h budget meter, which the sweep consults per row either way —
// concurrency raises the ceiling the meter can spend up to, never the spend itself.
const CONCURRENCY = Math.max(
  1,
  Math.trunc(Number(process.env.FLUNCLE_CAPTURE_CONCURRENCY ?? "1")) || 1,
);

// Duration guard: accept a candidate whose length is within max(±3s, ±3%) of the
// finding's Spotify duration. Duration catches the gross mismatches (edits/speed changes);
// a same-length remaster is fine (Unit 4's shape-normalized log-mel tolerates it).
const TOLERANCE_SEC = Number(process.env.FLUNCLE_CAPTURE_TOLERANCE_SEC ?? "3");
const TOLERANCE_PCT = Number(process.env.FLUNCLE_CAPTURE_TOLERANCE_PCT ?? "0.03");
// CHANNEL TRUST NO LONGER WAIVES THE DURATION GUARD (docs/the-ear.md § Wrong audio). It once
// widened the guard asymmetrically for a trusted channel (a +60s pad for a label/artist upload's
// intro sting + outro card) — and that pad is exactly the hole 005.9.9L fell through: an Elevate
// Records channel video whose AUDIO was a different song ran 48s over the master, inside the pad,
// and was stored as the finding's capture. So the trusted pad is GONE: every candidate takes the
// same symmetric guard, and trust now only helps RANK equals (below). The real identity check is
// the fingerprint gate — a candidate's captured bytes are verified against the ISRC-resolved
// official preview, whatever channel it came from. Nothing skips that gate.
// How many ranked candidates to attempt per finding before giving up: the top hit is
// sometimes DRM-locked or bot-walled, and a different upload of the same track downloads
// fine, so walk down the ranked list (fast-failing errors keep the cost low).
const DOWNLOAD_ATTEMPTS = Number(process.env.FLUNCLE_CAPTURE_DOWNLOAD_ATTEMPTS ?? "3");

// How many differently-shaped SEARCHES to spend on a finding before declaring `unmatched`.
// Default 2 = the primary `<artists> <title>` query PLUS one de-constrained fallback (primary
// artist + a version-stripped title, `buildSearchQuery` variant 1). The fallback is BILLED ONLY
// when the primary returned ZERO RAW candidates — the over-constrained multi-artist credit or the
// odd-punctuation title that found nothing on YouTube — never when candidates came back and missed
// the duration guard (then the song genuinely isn't there at that length). This is the ONLY
// per-search cost knob: the ceiling is exactly this many billed proxy searches per finding, and the
// walk never loops. Set to 1 to disable the fallback and restore the single-search behaviour.
// 3 = the full search ladder (raw ytsearch → music search → normalized fallback on music).
const QUERY_VARIANTS = Number(process.env.FLUNCLE_CAPTURE_QUERY_VARIANTS ?? "3");

// ── THE PROVENANCE PHASE'S BUDGET (see THE PROVENANCE PHASE below) ───────────────────
//
// How many already-captured rows the backfill re-derives a YouTube id for, per tick. It rides
// this sweep's tick rather than a timer of its own because the alternative — a new host timer —
// is an operator fan-out (a unit, an install, a runbook) for work that is the same work, through
// the same proxy, under the same brake; a phase self-deploys with the next rebake.
//
// DEFAULT 2, and the smallness is the point: each row is a FULL candidate download through the
// residential proxy, so this is real bandwidth money spent on provenance for audio Fluncle already
// owns. It is a backlog to grind down over weeks, never a batch to blast through — 2 a tick is
// ~576 rows a day, which clears the findings in an afternoon and the catalogue at a pace the
// operator can watch. The row is ATTEMPTED, not necessarily concluded: a row whose download fails
// transiently spends its slot and is retried on a later tick, which is what keeps the cost ceiling
// per tick honest and readable.
const PROVENANCE_LIMIT = Number(process.env.FLUNCLE_CAPTURE_PROVENANCE_LIMIT ?? "2");

// How many of those rows may be UNCERTIFIED catalogue rows. DEFAULT 0 — the backfill spends the
// whole budget on the findings and does not touch the catalogue until the operator says so, which
// is one env flip on the box and no code change. It is a SUB-cap, not an extra allowance: the
// catalogue can only ever use budget the findings did not, so opening it can never raise the tick's
// total spend above `PROVENANCE_LIMIT`. (The server's catalogue capture brake gates this queue too,
// so a shut budget serves no catalogue row regardless of what is set here.)
const PROVENANCE_CATALOGUE_LIMIT = Number(
  process.env.FLUNCLE_CAPTURE_PROVENANCE_CATALOGUE_LIMIT ?? "0",
);

// How many rows the RE-VERDICT phase re-rules per tick. Higher than the provenance budget because
// it costs nothing comparable: no download, no proxy, no bytes — the server answers each one with a
// single keyless oEmbed read. 5 a tick drains a widened rule through the whole 0/NULL set quickly
// and then keeps cycling (the queue is a round-robin by design — track-work.ts).
const REVERDICT_LIMIT = Number(process.env.FLUNCLE_CAPTURE_REVERDICT_LIMIT ?? "5");

const YT_SEARCH_TIMEOUT_MS = 60_000;
const YT_DOWNLOAD_TIMEOUT_MS = 180_000;

const log = (message: string) => console.error(`[capture-sweep] ${message}`);

// ── Pure helpers (exported for capture-sweep.test.ts) ─────────────────────────

/** A row as the capture worklist (`GET /api/v1/admin/tracks/work?kind=capture`) returns it. */
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
  // name equals the label is almost certainly the correct upload — a trust RANKING signal
  // (it never relaxes the duration guard; that waiver was the 005.9.9L hole). For
  // self-released tracks the label IS the artist name, so this doubles as an artist-channel
  // signal before `artist_socials` lands.
  label?: string;
  logId?: string;
  // The prior consecutive-failure count (the admin list DTO surfaces it when non-zero),
  // read so the failure bump ACCUMULATES — the queue's failure-cap backoff depends on it.
  sourceAudioFailures?: number;
  // The R2 key of the row's PRIOR capture (`<root>/<sha256>.<ext>`). Normally absent on a capture
  // worklist row (nothing captured yet), but a WRONG-AUDIO re-capture (docs/the-ear.md § Wrong
  // audio) KEEPS it: its embedded sha256 is the LEGACY single-sha memory (kept for backward compat
  // with rows quarantined before the general memory shipped). Present ⇒ reject any candidate whose
  // bytes hash to that sha256.
  sourceAudioKey?: string;
  // THE GENERAL BAD-AUDIO MEMORY (docs/the-ear.md § Wrong audio) — the JSON array of sources this
  // track's captures have been rejected from ({ videoId?, sha256, reason, at }, capped ~10). Two
  // filters ride it: the `videoId` is the PRE-download filter (a known-bad candidate never costs
  // proxy bytes again), the `sha256` the POST-download backstop (same audio, new id). Absent when
  // the worklist DTO omitted it (nothing rejected yet). Surfaced by list_track_work?kind=capture.
  sourceAudioRejected?: unknown;
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
 * A YouTube BOT-CHALLENGE verdict ("Sign in to confirm you're not a bot" and kin) is an
 * IP-REPUTATION ruling on the proxy exit, not on the video or the query — retrying through
 * the same flagged exit re-fails, and the player-client fallback can't clear it either.
 * Classified separately from DRM/403 so the caller can answer it with the one move that
 * works: a fresh sticky session (a new residential exit). Pure; pinned by tests.
 */
export function isBotChallengeStderr(stderr: string): boolean {
  return /Sign in to confirm|not a bot|Please sign in/i.test(stderr);
}

/** What a failed yt-dlp download's stderr says about WHY, and so about what to try next. */
export type DownloadErrorFlags = {
  is403?: boolean;
  isBotChallenge?: boolean;
  isRecoverable?: boolean;
};

/**
 * Read a failed download's stderr into the three flags the recovery decision runs on.
 *
 * `is403` is ANCHORED to the two forms yt-dlp actually prints. It used to also accept a bare
 * `\b403\b`, which matches anywhere in stderr — a video id, a byte offset, a URL — and since
 * the caller tested it FIRST, a bot-challenge stderr carrying a loose 403 was routed to the
 * player-client fallback. That fallback cannot clear an IP-reputation ruling (module header),
 * so the run's one re-roll went unspent on exactly the runs that needed it. The combined shape
 * is not hypothetical: per the yt-dlp wiki it is what a missing PO token produces.
 */
export function classifyDownloadFailure(stderr: string): DownloadErrorFlags {
  return {
    is403: /HTTP Error 403|status code 403/.test(stderr),
    isBotChallenge: isBotChallengeStderr(stderr),
    // DRM-locked or bot-walled: this specific VIDEO can't be pulled, but another candidate
    // for the same finding often can → the caller falls through to the next-ranked one.
    isRecoverable: /DRM protected|Sign in to confirm|not a bot/i.test(stderr),
  };
}

/** The three ways a failed download can be answered, in the order they are considered. */
export type DownloadRecovery = "reroll" | "player-client-fallback" | "give-up";

/**
 * THE RECOVERY DECISION, and the whole reason it is a function: the ORDER is the fix.
 *
 * A bot challenge is asked about FIRST, because both flags are read off the same stderr and a
 * challenge that also mentions a 403 is an IP-reputation verdict wearing a 403's clothes —
 * only a fresh residential exit clears it. The 403 branch keeps its second chance: it answers
 * a plain 403, and it still answers a challenge whose re-roll the run has already spent (there
 * is nothing better left to try). Anything else rethrows to the candidate walk.
 */
export function chooseDownloadRecovery(
  flags: DownloadErrorFlags,
  canReroll: boolean,
): DownloadRecovery {
  if (flags.isBotChallenge && canReroll) {
    return "reroll";
  }
  if (flags.is403) {
    return "player-client-fallback";
  }
  return "give-up";
}

/**
 * The ONE re-rolled sticky session for a track: `<id>.r1`. The `.` survives the session
 * sanitizer (alnum + `.`), keeps determinism (same track, same re-roll), and stays sticky —
 * the re-roll changes WHICH exit, never the one-exit-per-download rule the media fetch needs.
 * Deliberately single (no .r2): a pool that challenges two distinct exits in one run is
 * cooling off, and the retry budget belongs to the next sweep tick.
 */
export function rerollSessionId(sessionId: string): string {
  return `${sessionId}.r1`;
}

/**
 * The per-RUN sticky-session seed: `<id>` on a clean first run, `<id>.a<failures>` on a
 * retry. A bot-challenge flag is an IP-reputation ruling that outlives the run, and the
 * seed used to be the bare track id — so a `failed` row's next run landed on the exact
 * exit that just got flagged and burned a challenge (plus the run's one re-roll) before
 * seeing a fresh one. Folding the persisted failure count in rotates every retry run onto
 * an unburned exit for free, with no flagged-IP ledger to keep or expire (we never see
 * exit IPs — the provider maps session → exit; flags decay on their own). Within a run the
 * session stays sticky as before, and `.a<n>` never collides with the `.r1` re-roll
 * namespace (run N's re-roll is `<id>.a<n>.r1`). The `.` survives the session sanitizer.
 */
export function captureSessionSeed(idOrLogId: string, priorFailures: number): string {
  return priorFailures > 0 ? `${idOrLogId}.a${priorFailures}` : idOrLogId;
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

/**
 * The sha256 embedded in a source-audio R2 key (`<root>/<sha256>.<ext>`), lowercased, or null if
 * the basename is not a 64-hex-char digest. The inverse of `buildSourceAudioKey`'s hash slot — it
 * is how a WRONG-AUDIO re-capture recovers the bad hash from the row's kept key (docs/the-ear.md
 * § Wrong audio) with NO new vendor data, then refuses a re-download whose bytes hash identical.
 */
export function extractSourceAudioSha256(key: string | undefined): null | string {
  if (!key) {
    return null;
  }

  const base = key.split("/").pop() ?? "";
  const dot = base.indexOf(".");
  const hash = (dot >= 0 ? base.slice(0, dot) : base).toLowerCase();

  return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

// Title markers that signal a WRONG version (a same-length remix/edit slips the duration
// guard, so de-rank these before the guard even runs). g-flagged so a title's markers can
// be ENUMERATED and compared against the finding's own (`hasForeignVersionMarker`).
const WRONG_VERSION_MARKERS_ALL =
  /\b(remix|bootleg|live|sped[\s-]?up|slowed|nightcore|8d audio|cover|karaoke|instrumental|mashup|edit|rework|vip mix)\b/gi;

/**
 * Whether a candidate title carries a wrong-version marker THE FINDING ITSELF DOES NOT.
 * A finding whose own canonical title is "(Logistics remix)" must not have its correct
 * candidates de-ranked for saying "remix" — before this, any same-length non-remix upload
 * outranked the actual remix, a wrong-version-match risk (the 2026-07-14 unmatched audit,
 * class 4). A marker the finding does NOT carry still de-ranks exactly as before.
 */
export function hasForeignVersionMarker(candidateTitle: string, findingTitle?: string): boolean {
  const candidateMarkers = candidateTitle.match(WRONG_VERSION_MARKERS_ALL);

  if (!candidateMarkers) {
    return false;
  }

  const own = new Set(
    (findingTitle?.match(WRONG_VERSION_MARKERS_ALL) ?? []).map((m) => m.toLowerCase()),
  );

  return candidateMarkers.some((marker) => !own.has(marker.toLowerCase()));
}
const OFFICIAL_MARKERS = /(-\s*topic\b|official audio|official video|official music video)/i;

// A YouTube auto-generated art-track lives on an "<Artist> - Topic" CHANNEL, generated per artist
// from the label-delivered master: duration-exact, ISRC-tagged, the correct audio BY CONSTRUCTION.
// The signal is the channel NAME (the video TITLE is the bare song), so `OFFICIAL_MARKERS` — which
// tests the title — structurally misses it; this tests the channel. Recognizing it turns a Topic
// upload into the top-ranked, safest candidate (a ranking tiebreak only; the fingerprint gate is
// still the identity check, and the duration guard is untouched).
const TOPIC_CHANNEL_MARKER = /-\s*topic\s*$/i;

/** Whether a YouTube channel name is an auto-generated `<Artist> - Topic` art-track channel. */
export function isTopicChannel(channel: string | undefined): boolean {
  return channel ? TOPIC_CHANNEL_MARKER.test(channel.trim()) : false;
}

/**
 * A trailing version parenthetical/bracket — "(radio edit)", "[VIP Mix]", "(Original Mix)" — used
 * ONLY by the fallback query variant to de-noise a title. A DnB release nearly always carries the
 * version at the END; stripping mid-string tokens would corrupt real titles, so this is anchored.
 */
const TRAILING_VERSION_PAREN = /\s*[([][^)\]]*[)\]]\s*$/;

/**
 * Build the yt-dlp search query for a finding. Variant 0 is the PRIMARY shape — every credited
 * artist joined + the full title, whitespace-collapsed — kept byte-equivalent to the historic
 * query so a matching row never regresses. Variant 1 is the DE-CONSTRAINED FALLBACK the sweep
 * spends only when variant 0 found ZERO raw candidates: it drops the secondary artists (a
 * multi-credit like "Commix Nu:Tone Logistics Coffee" over-specifies the search and can return
 * nothing) and strips a trailing version parenthetical ("Technimatic Parallel (radio edit)" →
 * "Technimatic Parallel"), so the reshaped query reaches the upload the strict one missed. When a
 * single-artist clean title makes the two identical, the caller sees `variant1 === variant0` and
 * skips the pointless second billed search.
 */
export function buildSearchQuery(
  finding: { artists?: readonly string[]; title?: string },
  variant: 0 | 1,
): string {
  const artists = finding.artists ?? [];
  const title = finding.title ?? "";
  const collapse = (value: string) => value.trim().replace(/\s+/g, " ");

  if (variant === 0) {
    return collapse(`${artists.join(" ")} ${title}`);
  }

  const primaryArtist = artists[0] ?? "";
  const cleanedTitle = title.replace(TRAILING_VERSION_PAREN, "").trim();

  return collapse(`${primaryArtist} ${cleanedTitle}`);
}

/**
 * Fold a query to the ASCII shape YouTube uploads are actually typed in. MusicBrainz
 * canonical metadata carries typographic characters — U+2019 in "Won’t U", a real U+2010
 * hyphen in "NC‐17" — and intra-token punctuation ("S.P.Y", "Nu:Tone") that a literal
 * search can miss or down-rank. Measured on the 2026-07-14 unmatched spike (323 terminal
 * rows): the normalized primary-artist variant recovered 20 rows the raw query missed —
 * and the raw query found 11 the normalized one missed, so this is an ADDITIONAL search
 * step, never a replacement for the raw shape.
 */
export function normalizeSearchQuery(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[‐‒–—]/g, "-")
    .replace(/(?<=\w)[.:](?=\w)/g, "")
    .replace(/[.:](?=\s|$)/g, "")
    .replace(/&/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

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
// these (or on a channel named like the finding's label, or the artist's own channel) ranks
// ABOVE an equal untrusted upload — a tiebreak only; the duration guard stays symmetric for
// every tier (docs/the-ear.md § Wrong audio), and identity is the fingerprint gate's job now.
// Matched by normalized
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

// 0 = untrusted, 1 = verified-only, 2 = trusted (label match / curated allowlist / the artist's
// own channel). ALL tiers are ranking tiebreaks only — no tier relaxes the duration guard.
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
  // An `<Artist> - Topic` art-track is the artist's own auto-generated official channel (the
  // label-delivered master) — the strongest correctness signal after the artist's declared
  // channel, and it needs no per-artist allowlist. A ranking tiebreak only, like every tier.
  if (isTopicChannel(candidate.channel)) {
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

export type YtCandidate = {
  channel?: string;
  channelId?: string;
  durationSec: number;
  id: string;
  title: string;
  verified?: boolean;
};

/**
 * Pick the best YouTube candidate for a finding. Keep only candidates whose duration passes the
 * SYMMETRIC guard (`durationWithinTolerance`) — trust no longer widens it (docs/the-ear.md § Wrong
 * audio; the removed +60s trusted pad was the 005.9.9L hole) — then rank: CLEAN titles before
 * wrong-version markers (a trusted remix never beats an untrusted clean master), then higher
 * channel trust (the label/artist upload over a random re-host, even when the re-host is closer in
 * length — identity safety beats a few seconds of fidelity), then official/`- Topic`, then
 * verified, then closest duration. Trust is a RANKING signal only now; the fingerprint gate is the
 * identity check. Returns the pick WITH its trust tier (a soft tiebreak the caller carries) or
 * null → `unmatched`.
 */
export function rankCandidates(
  candidates: readonly YtCandidate[],
  context: {
    artistYoutubeChannelIds?: readonly string[];
    durationMs?: number;
    label?: string;
    title?: string;
  },
  options: { tolerancePct: number; toleranceSec: number } = {
    tolerancePct: TOLERANCE_PCT,
    toleranceSec: TOLERANCE_SEC,
  },
): { candidate: YtCandidate; trust: TrustTier }[] {
  const targetSec = context.durationMs && context.durationMs > 0 ? context.durationMs / 1000 : 0;
  const scored = candidates
    .map((candidate) => ({ candidate, trust: classifyChannelTrust(candidate, context) }))
    .filter(({ candidate }) =>
      durationWithinTolerance(candidate.durationSec, context.durationMs, options),
    )
    .map(({ candidate, trust }) => ({
      candidate,
      clean: hasForeignVersionMarker(candidate.title, context.title) ? 0 : 1,
      delta: Math.abs(candidate.durationSec - targetSec),
      // Title-borne official marker OR an `<Artist> - Topic` channel (the marker tests the title,
      // which a Topic upload leaves bare) — so a Topic art-track ranks above a plain tier-2 upload.
      official: OFFICIAL_MARKERS.test(candidate.title) || isTopicChannel(candidate.channel) ? 1 : 0,
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
  context: {
    artistYoutubeChannelIds?: readonly string[];
    durationMs?: number;
    label?: string;
    title?: string;
  },
  options?: { tolerancePct: number; toleranceSec: number },
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

/**
 * THE PRE-DOWNLOAD FILTER (docs/the-ear.md § Wrong audio): drop every ranked candidate whose
 * video id is already in the bad-audio memory, THEN take the attempt budget — so a known-bad
 * candidate never costs proxy bytes again, and `DOWNLOAD_ATTEMPTS` is spent only on uploads that
 * could actually be new audio. Order is load-bearing: filter first, budget second (a budget cut
 * first would let remembered ids eat attempt slots).
 */
export function filterRejectedCandidates<T extends { candidate: { id: string } }>(
  ranked: readonly T[],
  rejectedIds: ReadonlySet<string>,
  attempts: number,
): T[] {
  return ranked.filter((entry) => !rejectedIds.has(entry.candidate.id)).slice(0, attempts);
}

/** The capture-verification verdict for one downloaded file against a preview fingerprint. */
export type CaptureVerdict = "match" | "mismatch" | "no-reference";

/**
 * Verify a downloaded capture against the track's official-preview fingerprint (docs/the-ear.md §
 * Wrong audio). `previewFp` is the ISRC-resolved reference, fingerprinted once per track; null when
 * the track has no preview source OR fpcalc is absent — in which case the gate ABSTAINS
 * (`no-reference`), never blocks. Otherwise the capture is fingerprinted and slid against the
 * preview: a contained match ⇒ `match`, a clear miss ⇒ `mismatch`, an inconclusive/too-short
 * comparison ⇒ `no-reference` (abstain, never a false accusation). The caller maps `match` →
 * `preview-match`, `no-reference` → `unverified`, and rejects the candidate on `mismatch`.
 */
export function verifyCaptureFile(
  previewFp: number[] | null,
  captureFilePath: string,
): CaptureVerdict {
  if (previewFp === null) {
    return "no-reference";
  }

  const captureFp = fpcalcFingerprint(captureFilePath);

  if (captureFp === null) {
    return "no-reference";
  }

  const result = slidingWindowMatch(previewFp, captureFp);

  if (result === null) {
    return "no-reference";
  }

  return result.match ? "match" : "mismatch";
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

/**
 * Read one worklist. `kind` and `scope` are the server's enums (track-work.ts) — the ORDER and the
 * BRAKE are both decided there, so this is a dumb page read and deliberately has no opinion about
 * which rows it gets or how many are left behind.
 */
async function fetchTrackWork(options: {
  kind: "capture" | "youtube-provenance" | "youtube-reverdict";
  limit: number;
  scope: "all" | "catalogue" | "findings";
}): Promise<CaptureFinding[]> {
  const url = `${API_BASE_URL}/api/v1/admin/tracks/work?kind=${options.kind}&scope=${options.scope}&limit=${options.limit}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    // The Worker API worklist read (`list_track_work`), NOT a media download: ~10s p95 with a
    // tail past 30s, so a 30s budget tripped a false failure alert on the slow-but-completing
    // read. 60s clears the tail; the yt-dlp download/socket timeouts below are left untouched.
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(
      `${options.kind} queue read failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
  const body = (await res.json()) as { tracks?: CaptureFinding[] };
  return Array.isArray(body.tracks) ? body.tracks : [];
}

/**
 * The CAPTURE worklist (docs/gpu-batch-embed.md), NOT the old findings-only `captureQueue=true`
 * admin list. `kind=capture&scope=all` serves both halves in the metered-budget drain order
 * (certified first, then the Ear's capture-priority ladder); the budget's brake — consulted
 * server-side BEFORE the worklist is selected — narrows the scope to the findings while it is shut
 * (its default), so a paused brake reads exactly the findings the old queue did. No `order` param:
 * this queue's order is fixed by the budget.
 */
async function fetchCaptureQueue(): Promise<CaptureFinding[]> {
  return fetchTrackWork({ kind: "capture", limit: QUEUE_LIMIT, scope: "all" });
}

async function patchTrack(trackId: string, update: Record<string, unknown>): Promise<void> {
  const url = `${API_BASE_URL}/api/v1/admin/tracks/${encodeURIComponent(trackId)}`;
  const res = await fetch(url, {
    body: JSON.stringify(update),
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "PATCH",
    // The Worker API record write (`update_track`), NOT a media download: the mutation can run
    // slow-but-completing under load, so a 30s budget tripped a false failure alert. 60s clears
    // the tail; the yt-dlp download/socket timeouts elsewhere in this file are left untouched.
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(
      `update_track ${trackId} failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
}

// ── yt-dlp + ffprobe (subprocess) ────────────────────────────────────────────

function runYtSearch(
  proxyUrl: string,
  query: string,
  source: "music" | "youtube" = "youtube",
): YtCandidate[] {
  // Both sources resolve every entry fully (duration/channel/verified — the same billed
  // shape). "youtube" is the historic ytsearch5. "music" searches the SAME inventory
  // through music.youtube.com, where the auto-generated `<Artist> - Topic` art-tracks
  // that plain search buries rank first — measured 2026-07-14: it recovered 61% of the
  // catalogue's terminal-unmatched rows, duration-verified.
  const target =
    source === "music"
      ? [
          "--playlist-items",
          "1:5",
          `https://music.youtube.com/search?q=${encodeURIComponent(query)}`,
        ]
      : [`ytsearch5:${query}`];
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
      ...target,
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: YT_SEARCH_TIMEOUT_MS },
  );

  if (result.status !== 0) {
    const stderr = result.stderr || "";
    const err = new Error(`yt-dlp search failed: ${stderr.slice(0, 200)}`);
    (err as { isBotChallenge?: boolean }).isBotChallenge = isBotChallengeStderr(stderr);
    throw err;
  }

  const naToUndefined = (value?: string) => (value && value !== "NA" ? value : undefined);
  const candidates: YtCandidate[] = [];
  const seen = new Set<string>();
  for (const line of (result.stdout || "").split("\n")) {
    const [durationRaw, id, channelRaw, channelIdRaw, verifiedRaw, ...titleParts] =
      line.split("\t");
    if (!id || seen.has(id)) {
      // The music search page can list the same video twice (song + video shelf) — one
      // candidate per id keeps the download-attempt budget honest.
      continue;
    }
    seen.add(id);
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
    Object.assign(err, classifyDownloadFailure(stderr));
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

// ── THE BOT-CHALLENGE METER ──────────────────────────────────────────────────
//
// WHAT IT FIXES. The re-roll below fires at most ONCE per track-run (search and download
// share the one re-roll), and the log line used to live INSIDE that guard — so a run's
// second, third and fourth challenge were silent, and the number an operator could grep was
// a FLOOR ("runs that hit their FIRST challenge"), never a rate. Nothing could tell him
// whether a change to the proxy pool moved the challenge rate at all. Visibility and the
// re-roll are now separate concerns: the guard still decides whether to RE-ROLL, this meter
// always records. The tick's JSON summary carries the totals so the rate is readable without
// grepping (`botChallenges` / `botChallengesUncleared`).
//
// ── THE STRAIN CONTRACT ──────────────────────────────────────────────────────
// Since #994 `emit_cron_output` tees this sweep's STDERR into the /status marker, and
// fluncle-healthcheck.ts's `countDistressLines` scores every line of it against
// STRAIN_PHRASES. `log()` is `console.error`, so the WORDING below is load-bearing and the
// split is deliberate:
//
//   • A challenge the re-roll CLEARS is recoverable friction on a healthy tick — the run
//     moves to a fresh residential exit and usually completes. Measured over two days of box
//     output: 610 such runs against 5,100 attempts, ~12%. At that rate a scoring line puts
//     roughly 76 noisy points into every 6h window. The detector now ignores cleared challenges
//     entirely and applies a cadence-relative rate to the genuinely uncleared failures. So this
//     line carries NO strain phrase: it says "bot challenge" (a space) and never
//     "bot-challenged" (the hyphenated STRAIN_PHRASES entry).
//   • A challenge that arrives with the run's one re-roll already SPENT is the real thing:
//     the exit is flagged and there is nothing left to swap onto. That line KEEPS the
//     hyphenated "bot-challenged" and scores, exactly as before.
//   • The per-tick recap carries no phrase either. It reports a steady-state number, and a
//     number that is always present must never accrue strain.
//
// One hyphen is the entire difference, which is why both lines are built HERE, in one place,
// and pinned in capture-sweep.test.ts by running the REAL captured stderr through the REAL
// detector rather than by reasoning about the vocabulary.

/** Where in a run a challenge landed — search and download share the single re-roll. */
export type BotChallengeStage = "search" | "download";

/** The tick-wide challenge tally: every challenge, and the subset no re-roll could clear. */
export type BotChallengeMeter = { total: number; uncleared: number };

export function createBotChallengeMeter(): BotChallengeMeter {
  return { total: 0, uncleared: 0 };
}

/**
 * Record ONE bot challenge — always, whether or not a re-roll was available. `rerolled` says
 * which happened, and decides the wording per the strain contract above.
 */
export function noteBotChallenge(
  meter: BotChallengeMeter,
  stage: BotChallengeStage,
  rerolled: boolean,
): void {
  meter.total += 1;

  if (rerolled) {
    // Deliberately "bot challenge", never "bot-challenged" — see the strain contract above.
    log(`bot challenge at ${stage} (rerolled=true) — moving to a fresh residential exit`);
    return;
  }

  meter.uncleared += 1;
  log(`bot-challenged at ${stage} (rerolled=false) — the run's one re-roll is already spent`);
}

/**
 * The tick's recap, emitted once at the end of a tick that saw any challenge. Strain-free by
 * contract: the per-line signal above already scored the uncleared ones, and a recap that
 * scored would double-count a steady state into a permanent `degraded`.
 */
export function logBotChallengeRecap(meter: BotChallengeMeter): void {
  if (meter.total === 0) {
    return;
  }

  const cleared = meter.total - meter.uncleared;

  log(
    `bot challenges this tick: ${meter.total} (${cleared} cleared by a re-roll, ${meter.uncleared} with the re-roll spent)`,
  );
}

// ── THE SHARED YOUTUBE LADDER ───────────────────────────────────────────────
//
// Search → rank → download → duration re-check → FINGERPRINT GATE, extracted so the two sweeps
// that need it run the SAME one. The capture sweep runs it to acquire audio it will STORE; the
// provenance backfill (below) runs it to learn WHICH upload carries a recording whose audio is
// already on file, and throws the bytes away. That difference is entirely in what the CALLER does
// with the result — a parallel copy of this walk would drift within a release, and the thing it
// would drift on is the identity gate that keeps wrong audio out of the archive.

/**
 * ONE sticky residential-proxy session for one track's run, with its single bot-challenge re-roll.
 * `url` is what every yt-dlp call reads and `reroll` flips it exactly once (module header: a
 * challenge is an IP-reputation verdict on the exit, so the only answer is a different exit).
 * Every challenge is METERED whether or not a re-roll is left — the meter and the guard are
 * deliberately separate concerns (see THE BOT-CHALLENGE METER above).
 */
export type ProxySession = {
  /** Whether the run still has its one re-roll — read BEFORE `reroll` spends it. */
  rerollable: () => boolean;
  /** Meter a challenge, and move to a fresh exit if the run has a re-roll left. */
  reroll: (stage: BotChallengeStage) => boolean;
  url: string;
};

function openProxySession(sessionSeed: string, meter: BotChallengeMeter): ProxySession {
  const rerolledProxyUrl = buildStickyProxyUrl({
    host: PROXY_HOST,
    password: PROXY_PASSWORD,
    port: PROXY_PORT,
    sessionId: rerollSessionId(sessionSeed),
    username: PROXY_USERNAME,
  });
  const session: ProxySession = {
    reroll: (stage: BotChallengeStage) => {
      const canReroll = session.url !== rerolledProxyUrl;

      noteBotChallenge(meter, stage, canReroll);

      if (!canReroll) {
        return false;
      }

      session.url = rerolledProxyUrl;
      return true;
    },
    rerollable: () => session.url !== rerolledProxyUrl,
    url: buildStickyProxyUrl({
      host: PROXY_HOST,
      password: PROXY_PASSWORD,
      port: PROXY_PORT,
      sessionId: sessionSeed,
      username: PROXY_USERNAME,
    }),
  };

  return session;
}

/** The bad-audio memory as the walk carries it: the sources, plus whether THIS run grew them. */
export type RejectedMemory = { dirty: boolean; sources: RejectedSource[] };

/** An upload the fingerprint gate accepted, with the downloaded file still on disk. */
export type VerifiedUpload = {
  bytes: Uint8Array;
  digest: string;
  ext: string;
  path: string;
  /** `match` = fingerprint-verified. `no-reference` = the honest abstain (nothing was compared). */
  verdict: "match" | "no-reference";
  videoId: string;
};

/**
 * Run the ladder for one track and return the first upload that clears the fingerprint gate, or
 * `null` when the walk DISPROVED every candidate it could reach.
 *
 * THROWS on a transient failure (a proxy error, a bot wall that outlived the re-roll, a DRM-locked
 * top hit with nothing usable behind it), exactly as the inline walk did — a recoverable skip
 * disproves nothing, so it must not be allowed to read as a terminal verdict (the 047.0.8M case).
 * `memory` is mutated in place, so a caller that persists it keeps every paid-for rejection.
 */
async function findVerifiedUpload(options: {
  dir: string;
  finding: CaptureFinding;
  /**
   * A source-audio R2 key whose embedded sha256 is KNOWN-BAD for this track — the legacy
   * single-sha memory a row quarantined before the general one shipped still carries. CALLER-
   * SUPPLIED, never read off the row here, because `source_audio_key` means opposite things to
   * the two callers (see the backstop below).
   */
  legacyRejectKey?: string;
  memory: RejectedMemory;
  session: ProxySession;
}): Promise<VerifiedUpload | null> {
  const { dir, finding, memory, session } = options;
  const { trackId } = finding;
  const primaryQuery = buildSearchQuery(finding, 0);

  // THE SEARCH LADDER (bounded — QUERY_VARIANTS billed searches max, never a loop).
  // Ranked ACCEPTANCE is the gate between steps, not raw-candidate count: the 2026-07-14
  // unmatched audit showed an over-constrained multi-artist query routinely returns five
  // WRONG candidates (live sets, shorts) that all miss the duration guard — under the old
  // "zero raw candidates" trigger that suppressed the fallback exactly when it was needed.
  // The rungs, in measured-yield order (the 323-row spike):
  //   1. ytsearch5 with the historic raw query — byte-identical, no regression.
  //   2. the SAME query against music.youtube.com — the auto-generated `<Artist> - Topic`
  //      art-tracks rank first there; this step alone recovered 61% of the terminal-
  //      unmatched set, duration-verified.
  //   3. the normalized de-constrained variant (primary artist + version-stripped title,
  //      typographic punctuation folded) on music — +20 rows the raw shape missed.
  const rankContext = {
    artistYoutubeChannelIds: finding.artistYoutubeChannelIds,
    durationMs: finding.durationMs,
    label: finding.label,
    title: finding.title,
  };
  const fallbackQuery = normalizeSearchQuery(buildSearchQuery(finding, 1));
  const ladder: { query: string; source: "music" | "youtube" }[] = [
    { query: primaryQuery, source: "youtube" },
    { query: primaryQuery, source: "music" },
    ...(fallbackQuery && fallbackQuery !== primaryQuery
      ? [{ query: fallbackQuery, source: "music" as const }]
      : []),
  ].slice(0, Math.max(1, QUERY_VARIANTS));

  let candidates: YtCandidate[] = [];
  let ranked: ReturnType<typeof rankCandidates> = [];
  for (const [step, rung] of ladder.entries()) {
    if (step > 0) {
      log(
        `no accepted candidate yet — ladder step ${step + 1}/${ladder.length}: ${rung.source} search "${rung.query}"`,
      );
    }
    try {
      candidates = runYtSearch(session.url, rung.query, rung.source);
    } catch (error) {
      if (!(error as { isBotChallenge?: boolean }).isBotChallenge || !session.reroll("search")) {
        throw error;
      }
      candidates = runYtSearch(session.url, rung.query, rung.source);
    }
    ranked = rankCandidates(candidates, rankContext);
    if (ranked.length > 0) {
      break;
    }
  }

  // The ladder concluded and nothing survived the duration guard. The CALLER owns what that
  // means and what it writes: for capture it is a terminal `unmatched`, for the provenance
  // backfill it is a `no-match` report that moves no capture column at all.
  if (ranked.length === 0) {
    return null;
  }

  // ── THE BAD-AUDIO MEMORY (docs/the-ear.md § Wrong audio) ──────────────────────────────────
  // Two layers. The GENERAL memory (`source_audio_rejected`) drives a videoId PRE-download
  // filter + a sha256 POST-download backstop. The LEGACY single-sha (embedded in a kept
  // `source_audio_key`) is folded into the same backstop, so a row quarantined before the
  // general memory shipped still refuses its known-bad bytes. `memoryDirty` tracks whether this
  // run added a rejection, so the terminal write persists the grown memory exactly once.
  const rejectedIds = rejectedVideoIds(memory.sources);
  const knownBadShas = rejectedShas(memory.sources);
  // …and the LEGACY single-sha, which the CALLER supplies rather than this function reading it off
  // the row. That is not indirection for its own sake: `source_audio_key` means opposite things to
  // the two callers. On a CAPTURE it is only ever present on a wrong-audio re-capture, so its sha
  // is known-BAD. On the PROVENANCE backfill every row has a key by definition, and its sha is the
  // GOOD audio the archive is holding — folding that in would blacklist the one upload most likely
  // to be the right answer, which is exactly the upload the original capture came from.
  const legacyRejectHash = extractSourceAudioSha256(options.legacyRejectKey);
  if (legacyRejectHash) {
    knownBadShas.add(legacyRejectHash);
  }

  // PRE-DOWNLOAD FILTER: a candidate whose video id is already remembered as bad never costs
  // proxy bytes again. Applied before the attempt budget, so DOWNLOAD_ATTEMPTS is spent only on
  // candidates that could actually be new audio.
  const attempts = filterRejectedCandidates(ranked, rejectedIds, DOWNLOAD_ATTEMPTS);

  // ── THE REFERENCE ────────────────────────────────────────────────────────────────────────
  // The ISRC-resolved official 30s preview, fingerprinted ONCE per track (not per candidate).
  // null ⇒ the track has NO preview source, or fpcalc is absent — the gate then ABSTAINS on
  // whatever downloads (stamped `unverified`), never blocking a track that has no reference.
  // The preview is a verification REFERENCE only: never a vector, never a stored analysis input.
  const previewFp = await fetchPreviewFingerprint({
    apiBaseUrl: API_BASE_URL,
    apiToken: API_TOKEN,
    idOrLogId: trackId,
  });

  // Walk the (pre-filtered) candidates: download → known-bad sha backstop → real-duration
  // re-check → THE FINGERPRINT GATE. A verified MATCH (or an abstain, when there is no
  // reference) is RETURNED to the caller; a fingerprint MISMATCH rejects the candidate,
  // remembers it, and falls through to the next upload. A DRM/bot-walled hit is skipped
  // (recoverable) but keeps the run off a terminal verdict (see below); a non-recoverable
  // error aborts.
  let lastError: unknown;
  for (const candidate of attempts) {
    try {
      let file: { ext: string; path: string };
      try {
        file = runYtDownload(session.url, candidate.candidate.id, dir, false);
      } catch (error) {
        const flags = error as DownloadErrorFlags;
        // Decided BEFORE the re-roll fires, since the re-roll is what spends `canReroll`.
        const recovery = chooseDownloadRecovery(flags, session.rerollable());

        // Metered whichever branch wins — a challenge the run cannot clear is still a
        // challenge, and its visibility must not ride on there being a re-roll left.
        if (flags.isBotChallenge) {
          session.reroll("download");
        }

        if (recovery === "reroll") {
          // A fresh exit usually clears the challenge for the SAME candidate; if it
          // throws again the outer catch handles it as before (recoverable → next
          // candidate, since the run's one re-roll is now spent).
          file = runYtDownload(session.url, candidate.candidate.id, dir, false);
        } else if (recovery === "player-client-fallback") {
          file = runYtDownload(session.url, candidate.candidate.id, dir, true);
        } else {
          throw error;
        }
      }

      const fileBytes = new Uint8Array(readFileSync(file.path));
      const fileDigest = createHash("sha256").update(fileBytes).digest("hex");

      // KNOWN-BAD BYTES (the deep backstop): the same wrong audio re-uploaded under a new id.
      if (knownBadShas.has(fileDigest)) {
        log(`candidate ${candidate.candidate.id} is the known wrong audio — trying next`);
        rmSync(file.path, { force: true });
        continue;
      }

      // Belt-and-suspenders: confirm the REAL downloaded duration passes the SYMMETRIC guard
      // (the search value can lie / point at a different manifest). A wrong-LENGTH file is a
      // plain miss, not a same-recording claim, so it is skipped but NOT remembered.
      const realDurationSec = probeDurationSec(file.path);
      if (!durationWithinTolerance(realDurationSec, finding.durationMs)) {
        rmSync(file.path, { force: true });
        continue;
      }

      // ── THE FINGERPRINT GATE ──────────────────────────────────────────────────────────────
      const verdict = verifyCaptureFile(previewFp, file.path);

      if (verdict === "mismatch") {
        // WRONG AUDIO: the captured bytes do not match the ISRC-resolved preview (the 005.9.9L
        // failure). Remember the source — videoId (PRE-download filter) + sha (backstop) — so it
        // never costs bytes again, and fall through to the next upload.
        log(`candidate ${candidate.candidate.id} failed fingerprint verification — trying next`);
        memory.sources = appendRejectedSource(memory.sources, {
          at: new Date().toISOString(),
          reason: "fingerprint-mismatch",
          sha256: fileDigest,
          videoId: candidate.candidate.id,
        });
        memory.dirty = true;
        knownBadShas.add(fileDigest);
        rmSync(file.path, { force: true });
        continue;
      }

      // ACCEPTED. The file is still on disk and the caller decides its fate: the capture sweep
      // stores the bytes in R2, the provenance backfill deletes them and keeps only the id.
      return {
        bytes: fileBytes,
        digest: fileDigest,
        ext: file.ext,
        path: file.path,
        verdict,
        videoId: candidate.candidate.id,
      };
    } catch (error) {
      lastError = error;
      if ((error as { isRecoverable?: boolean }).isRecoverable) {
        log(`candidate ${candidate.candidate.id} unusable (DRM/bot-wall) — trying next`);
        continue;
      }
      throw error;
    }
  }

  // Nothing accepted. `null` — a terminal verdict for the caller to name — is returned ONLY when
  // the walk actually DISPROVED every upload: each fresh candidate was WRONG AUDIO (known-bad or
  // a fingerprint mismatch) or wrong-length, or the pre-filter left nothing to try. A recoverable
  // skip (DRM/bot-wall) disproves nothing — the skipped upload can be the RIGHT audio (the
  // 047.0.8M case: the correct art-track bot-walled, two wrong songs fingerprint-rejected, and
  // the rejections masked the transient error into a terminal verdict) — so any `lastError`
  // rethrows into the caller's retryable path.
  if (!lastError) {
    return null;
  }

  throw lastError;
}

// ── Per-finding capture ────────────────────────────────────────────────────

type FindingOutcome = "done" | "unmatched" | "failed" | "skipped";

async function captureFinding(
  finding: CaptureFinding,
  meter: BotChallengeMeter,
): Promise<FindingOutcome> {
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

  // The persisted consecutive-failure count: drives the retry backoff bookkeeping in the
  // catch below AND rotates the sticky session per retry run (captureSessionSeed) so a
  // retry never re-lands on the exit whose flag just failed it.
  const priorFailures =
    typeof finding.sourceAudioFailures === "number" ? finding.sourceAudioFailures : 0;
  const session = openProxySession(captureSessionSeed(logId ?? trackId, priorFailures), meter);

  const dir = mkdtempSync(join(tmpdir(), "fluncle-capture-"));

  // The bad-audio memory lives OUTSIDE the try: a run that grew it and then errored still
  // persists it on the `failed` patch in the catch, so a paid-for rejection is never lost.
  const memory: RejectedMemory = {
    dirty: false,
    sources: parseRejectedSources(finding.sourceAudioRejected),
  };

  try {
    // A capture row carries `source_audio_key` ONLY on a wrong-audio re-capture, where its sha is
    // the known-bad audio the walk must refuse. That is the legacy single-sha memory.
    const accepted = await findVerifiedUpload({
      dir,
      finding,
      legacyRejectKey: finding.sourceAudioKey,
      memory,
      session,
    });

    if (!accepted) {
      // `unmatched` is terminal — the queue never re-burns it; a fresh finding still jumps it
      // newest-first. `sourceAudioAttemptedAt` is stamped here too: it was a billed proxy request,
      // and the capture budget's ledger counts attempts rather than successes — a day of unmatched
      // rows still spends money, and a meter that could not see that would read zero while the bill
      // climbed. See apps/web/src/lib/server/capture-budget.ts.
      const update: Record<string, unknown> = {
        captureStatus: "unmatched",
        sourceAudioAttemptedAt: new Date().toISOString(),
      };
      if (memory.dirty) {
        update.sourceAudioRejected = JSON.stringify(memory.sources);
      }
      await patchTrack(trackId, update);
      return "unmatched";
    }

    // MATCH → `preview-match`; NO-REFERENCE → `unverified` (the honest abstain). Store the
    // bytes + stamp the verdict provenance in the same write.
    const verification = accepted.verdict === "match" ? "preview-match" : "unverified";
    const key = buildSourceAudioKey(keyRoot, accepted.digest, accepted.ext);

    await r2Put(key, accepted.bytes, contentTypeForExt(accepted.ext));

    // The key + done + the captured stamp + THE METER + THE VERIFICATION PROVENANCE.
    // Clobber-safe enrichment trigger — for a CERTIFIED finding, re-queue when the BPM is
    // missing OR the row was analyzed from a preview (closing the capture→enrich race; a
    // catalogue row has no enrichment and is skipped). `sourceAudioBytes` is the billed size,
    // knowable only HERE. `sourceAudioAttemptedAt` is stamped on success too (the budget's
    // rolling-24h ledger is a range seek on it). If this run REJECTED an earlier candidate,
    // the grown memory rides this write so it is never lost.
    // THE ACCEPTED UPLOAD'S ID rides this write (operator ruling 2026-07-31). Until now the
    // walk remembered only the ids it REJECTED (`sourceAudioRejected`) and threw the winner
    // away at the moment it was most certain — this is the one place that knows which YouTube
    // upload carries this recording, proven by the fingerprint gate. The server decides
    // separately whether that upload may ever be SHOWN (a rip carries the same bytes as the
    // master, so a fingerprint match is identity, never permission); the sweep's whole job is
    // to report the id. Rows captured BEFORE this shipped are reached by the PROVENANCE PHASE
    // below, which re-derives the id without touching a single capture column.
    const now = new Date().toISOString();
    const update: Record<string, unknown> = {
      captureStatus: "done",
      captureVerification: verification,
      captureVerifiedAt: now,
      sourceAudioAttemptedAt: now,
      sourceAudioBytes: accepted.bytes.byteLength,
      sourceAudioCapturedAt: now,
      sourceAudioKey: key,
    };

    // ONLY A REAL MATCH REPORTS AN ID. `verification` is `unverified` on the abstain path —
    // the track had no preview reference (or fpcalc was absent), so the bytes were accepted on
    // duration and ranking alone and NOTHING was fingerprinted. The identity envelope serves
    // this id under `method: "fingerprint"`, so shipping one from the abstain path would put
    // the words "matched by audio fingerprint" on a page under a match that never happened.
    // The server re-checks this same condition (lib/server/track-update.ts) rather than
    // trusting the box, but the honest source is here.
    if (accepted.verdict === "match") {
      update.youtubeVideoId = accepted.videoId;
    }
    if (memory.dirty) {
      update.sourceAudioRejected = JSON.stringify(memory.sources);
    }
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
    // absent → 0 → a first failure lands 1, a second lands 2, … up to the cap. The bumped
    // count also rotates the NEXT run's session seed (captureSessionSeed above).
    const update: Record<string, unknown> = {
      captureStatus: "failed",
      sourceAudioAttemptedAt: new Date().toISOString(),
      sourceAudioFailures: priorFailures + 1,
    };
    if (memory.dirty) {
      update.sourceAudioRejected = JSON.stringify(memory.sources);
    }
    await patchTrack(trackId, update).catch((patchError: unknown) => {
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

// ── THE PROVENANCE PHASE (operator ruling 2026-07-31) ───────────────────────
//
// WHAT IT IS FOR. The capture write above keeps the winning video id — but only from the moment it
// shipped. Every row captured before that had its id discarded at the instant it was most certain,
// and a discarded id cannot be recovered from the stored bytes: nothing in an R2 object says which
// upload it came from. So the only honest way to fill those rows is to ask the question again, and
// that means running the whole ladder again.
//
// ── AND IT THROWS THE AUDIO AWAY. THIS IS THE RULING, NOT AN OPTIMISATION ────────────────────
// The obvious shape — just re-capture the row and let the normal write keep the id — was piloted
// over three rows and REJECTED on what it did: a recapture REPLACED a finding's clean archived
// audio with a fan BLEND that legitimately passed the fingerprint gate. It passed because a blend
// CONTAINS the original's preview segment, so the gate is working exactly as designed and simply
// cannot tell the two apart. The archive is the thing Fluncle is least willing to degrade, and a
// backfill that trades good audio for a provenance link is a bad trade at any hit rate.
//
// So this phase is PROVENANCE-ONLY, and the rail is absolute: it never sends `sourceAudioKey`,
// `captureStatus`, `captureVerification`, `sourceAudioBytes`, `sourceAudioRejected`, or any other
// capture column. The candidate file is deleted the moment the verdict is read. The only thing it
// can move is the YouTube trio, and it moves that through its OWN verdict field
// (`youtubeVerification`) precisely so it cannot borrow capture's — sending
// `captureVerification: "preview-match"` from a sweep that stored nothing would be a lie about the
// archive, and the honest field costs one line.
//
// IT READS THE BAD-AUDIO MEMORY AND NEVER WRITES IT. Reading is free and saves money: a candidate a
// previous capture already proved wrong is filtered out before it costs proxy bytes. Writing would
// be a capture column, so a rejection this phase pays for is not remembered — the accepted cost of
// a rail with no exceptions in it.

/** What one provenance row cost and what it concluded. */
type ProvenanceOutcome = "found" | "none" | "failed";

/**
 * Re-derive one already-captured row's YouTube provenance: run the ladder, read the verdict, throw
 * the bytes away, report the id.
 *
 * A NON-MATCH IS REPORTED TOO (`no-match`), and it has to be. The ladder just spent a real download
 * on this row; without a record of that the worklist would hand the same row back on the next tick
 * and buy it again, forever. The report stamps `youtube_verified_at` and nothing else, which is
 * what puts the row inside the server's re-ask window (track-work.ts). It covers both ways of
 * concluding without a reportable id: nothing matched, and nothing could be COMPARED (a track with
 * no preview reference is the ladder's honest abstain — its id is unprovable, so it is unreportable,
 * and re-asking every tick would buy the same nothing).
 */
async function proveTrackProvenance(
  row: CaptureFinding,
  meter: BotChallengeMeter,
): Promise<ProvenanceOutcome> {
  const { logId, trackId } = row;
  // The same sticky-session shape a clean capture run uses — determinism per track is all
  // stickiness needs, and sharing the shape means sharing the behaviour that was tuned for it.
  const session = openProxySession(captureSessionSeed(logId ?? trackId, 0), meter);
  const dir = mkdtempSync(join(tmpdir(), "fluncle-provenance-"));
  // READ-ONLY (see the phase header): it feeds the pre-download filter and is never written back.
  const memory: RejectedMemory = {
    dirty: false,
    sources: parseRejectedSources(row.sourceAudioRejected),
  };

  try {
    // NO `legacyRejectKey`. Every row here has a `source_audio_key` by definition — it is the
    // queue's own predicate — and that key's sha is the GOOD audio the archive holds. Passing it
    // as a known-bad hash, the way the capture path correctly does for a quarantined row, would
    // blacklist the upload most likely to be the right answer: the one the original capture came
    // from. Same field, opposite meaning, which is why the caller supplies it and the walk does not.
    const accepted = await findVerifiedUpload({ dir, finding: row, memory, session });

    // THE DISCARD, first and unconditionally. The bytes exist only to be fingerprinted; nothing
    // downstream may read them, and the `finally` below removes the directory regardless.
    if (accepted) {
      rmSync(accepted.path, { force: true });
    }

    if (!accepted || accepted.verdict !== "match") {
      await patchTrack(trackId, { youtubeVerification: "no-match" });
      return "none";
    }

    // ONLY the id and its proof. No capture column appears in this body, by construction — the
    // server accepts the pair and refuses a bare id exactly as it does on the capture path.
    await patchTrack(trackId, {
      youtubeVerification: "preview-match",
      youtubeVideoId: accepted.videoId,
    });

    return "found";
  } catch (error) {
    // NOTHING IS WRITTEN on a transient failure — no stamp, no id, and above all no capture
    // column. The row keeps its place in the worklist and is asked again on a later tick, which is
    // the right answer for a proxy hiccup and costs only the slot this tick already spent.
    log(
      `provenance failed for ${logId ?? "catalogue"} (${trackId}): ${error instanceof Error ? error.message : String(error)}`,
    );

    return "failed";
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

/** The provenance phase's tally for the tick summary. */
export type ProvenanceCounts = { failed: number; found: number; none: number };

/**
 * Split the tick's provenance budget between the two halves of the archive.
 *
 * FINDINGS FIRST and the catalogue only with what is left: the sub-cap can never RAISE the tick's
 * total spend, only redirect the part the findings did not need. With the shipped default of 0 the
 * catalogue read is skipped entirely — no request, no page, no possibility of spending.
 */
export function splitProvenanceBudget(
  total: number,
  catalogueCap: number,
): { catalogue: number; findings: number } {
  const findings = Math.max(0, Math.trunc(total) || 0);

  return { catalogue: Math.min(Math.max(0, Math.trunc(catalogueCap) || 0), findings), findings };
}

async function runProvenancePhase(meter: BotChallengeMeter): Promise<ProvenanceCounts> {
  const counts: ProvenanceCounts = { failed: 0, found: 0, none: 0 };
  const budget = splitProvenanceBudget(PROVENANCE_LIMIT, PROVENANCE_CATALOGUE_LIMIT);

  if (budget.findings === 0) {
    return counts;
  }

  // The findings half fills the budget first. Asking for the whole budget from `scope=findings`
  // rather than `scope=all` is what makes the catalogue sub-cap a real cap rather than a hope: a
  // catalogue row cannot arrive in this page at all.
  const rows = await fetchTrackWork({
    kind: "youtube-provenance",
    limit: budget.findings,
    scope: "findings",
  });

  // …and only what the findings left over may go to the catalogue, up to the sub-cap.
  const catalogueRoom = Math.min(budget.catalogue, budget.findings - rows.length);

  if (catalogueRoom > 0) {
    rows.push(
      ...(await fetchTrackWork({
        kind: "youtube-provenance",
        limit: catalogueRoom,
        scope: "catalogue",
      })),
    );
  }

  // SERIAL, not the capture batch's worker pool. The budget is two rows; a pool over two rows buys
  // nothing and would only widen the concurrent proxy footprint of a tick that is already running
  // its capture batch.
  for (const row of rows) {
    counts[await proveTrackProvenance(row, meter)] += 1;
  }

  return counts;
}

// ── THE RE-VERDICT PHASE ────────────────────────────────────────────────────
//
// A row already HOLDS an id, and its officialness was ruled 0 or never concluded. The rule that
// ruled it has since widened (a recording's own label channel now counts — youtube-official.ts), so
// the question is asked again. The box's whole part in this is pacing: it reads the queue and sends
// a `youtubeReverdict` ask per row. It never fetches the oEmbed, never sees a channel name, and
// never carries a verdict — permission is decided server-side or it is not decided at all.

async function runReverdictPhase(): Promise<{ asked: number; failed: number }> {
  const limit = Math.max(0, Math.trunc(REVERDICT_LIMIT) || 0);

  if (limit === 0) {
    return { asked: 0, failed: 0 };
  }

  // `scope=all`: this phase spends no metered bandwidth, so there is no reason to hold the
  // catalogue's rows back from a free re-ask.
  const rows = await fetchTrackWork({ kind: "youtube-reverdict", limit, scope: "all" });
  let asked = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await patchTrack(row.trackId, { youtubeReverdict: true });
      asked += 1;
    } catch (error) {
      failed += 1;
      log(
        `re-verdict failed for ${row.trackId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { asked, failed };
}

// ── Main ────────────────────────────────────────────────────────────────────

type CaptureCounts = {
  done: number;
  failed: number;
  skipped: number;
  unmatched: number;
};

export function buildCaptureSummary(options: {
  batch: number;
  botChallenges: number;
  botChallengesUncleared: number;
  counts: CaptureCounts;
  elapsedMs: number;
  provenance: ProvenanceCounts;
  reverdict: { asked: number; failed: number };
}): Record<string, unknown> {
  const { counts, provenance, reverdict } = options;

  return {
    batch: options.batch,
    botChallenges: options.botChallenges,
    botChallengesUncleared: options.botChallengesUncleared,
    checked: options.batch,
    done: counts.done,
    elapsedMs: options.elapsedMs,
    errors: 0,
    failed: counts.failed,
    ok: true,
    produced: counts.done,
    // THE PROVENANCE PHASE, reported separately from the capture batch it rides. Kept out of
    // `checked`/`failed`/`produced` on purpose: those are the CAPTURE gauges the /status strain
    // detector reads as a rate, and folding a different unit of work into them would move a
    // published health number for a reason that has nothing to do with capture's health.
    provenanceFailed: provenance.failed,
    provenanceFound: provenance.found,
    provenanceNone: provenance.none,
    reverdictAsked: reverdict.asked,
    reverdictFailed: reverdict.failed,
    // Deliberately no `queue_depth`: capture's whole-backlog count is an unindexed hot-path scan.
    skipped: counts.skipped,
    unmatched: counts.unmatched,
  };
}

export function buildCaptureConfigFailureSummary(reason: string): Record<string, unknown> {
  return {
    checked: 0,
    errors: 1,
    failed: 0,
    ok: false,
    produced: 0,
    reason,
  };
}

export function buildCaptureFatalSummary(error: unknown): Record<string, unknown> {
  return {
    checked: null,
    error: error instanceof Error ? error.message : String(error),
    errors: 1,
    failed: null,
    ok: false,
    produced: null,
    reason: "capture_failed",
  };
}

async function main(): Promise<void> {
  const started = Date.now();

  if (!API_TOKEN) {
    console.log(JSON.stringify(buildCaptureConfigFailureSummary("missing_api_token")));
    process.exit(1);
  }
  if (!PROXY_HOST || !PROXY_PORT || !PROXY_USERNAME || !PROXY_PASSWORD) {
    console.log(JSON.stringify(buildCaptureConfigFailureSummary("missing_proxy_credentials")));
    process.exit(1);
  }
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    console.log(JSON.stringify(buildCaptureConfigFailureSummary("missing_r2_credentials")));
    process.exit(1);
  }

  const queue = await fetchCaptureQueue();
  const batch = queue.slice(0, Number.isFinite(BATCH_CAP) && BATCH_CAP > 0 ? BATCH_CAP : 4);

  const counts = { done: 0, failed: 0, skipped: 0, unmatched: 0 };
  // ONE meter for the whole tick, shared by every worker (each `+= 1` is synchronous, so the
  // pool cannot lose a count). It rides into the summary below as the rate an operator can
  // finally read per tick instead of grepping a floor out of the journal.
  const botChallenges = createBotChallengeMeter();

  // A fixed worker pool over the batch: `CONCURRENCY` workers each pull the next index. Catch
  // per-finding inside the worker — one failure must never abort the tick or starve a worker.
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < batch.length) {
      const finding = batch[cursor];
      cursor += 1;

      if (!finding) {
        return;
      }

      try {
        const outcome = await captureFinding(finding, botChallenges);
        counts[outcome] += 1;
      } catch (error) {
        counts.failed += 1;
        log(
          `unexpected error on ${finding.trackId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, batch.length) || 1 }, () => worker()),
  );

  // ── THE PROVENANCE PHASE, after the capture batch and never instead of it ──────────────────
  // Ordered last on purpose: acquisition is the sweep's job and a backfill must never be able to
  // delay or starve it. Both phases are caught here rather than thrown, for the same reason the
  // capture worker catches per row — a backfill that could abort the tick would be able to hide a
  // capture that already succeeded.
  const provenance = await runProvenancePhase(botChallenges).catch((error: unknown) => {
    log(`provenance phase failed: ${error instanceof Error ? error.message : String(error)}`);

    return { failed: 0, found: 0, none: 0 } satisfies ProvenanceCounts;
  });
  const reverdict = await runReverdictPhase().catch((error: unknown) => {
    log(`re-verdict phase failed: ${error instanceof Error ? error.message : String(error)}`);

    return { asked: 0, failed: 0 };
  });

  logBotChallengeRecap(botChallenges);

  console.log(
    JSON.stringify(
      buildCaptureSummary({
        batch: batch.length,
        // THE CHALLENGE RATE, per tick. Neither key is in the healthcheck's failure vocabulary,
        // so publishing the number does not by itself make a steady state read as strain.
        botChallenges: botChallenges.total,
        botChallengesUncleared: botChallenges.uncleared,
        counts,
        elapsedMs: Date.now() - started,
        // Deliberately NO `queue_depth`. `queue.length` is only the bounded page, while the honest
        // `count=true` capture predicate scans the growing tracks table plus its findings join on
        // every hot-path tick (capture has no covering queue index). Until an operator-approved,
        // hosted-Turso-proven index exists, omission is the only honest and affordable gauge.
        //
        // `checked` IS emitted, so item-level `failed` is now judged as a RATE against it rather
        // than counted. A steady ~4-of-12 tick is ~33%, under the 50% bar, so this sweep's honest
        // baseline against bot challenges no longer parks it on the public degraded row.
        provenance,
        reverdict,
      }),
    ),
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const summary = buildCaptureFatalSummary(error);
    log(`capture sweep failed: ${String(summary.error)}`);
    console.log(JSON.stringify(summary));
    process.exit(1);
  });
}
