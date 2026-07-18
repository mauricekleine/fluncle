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
// needsReenrichAfterCapture / buildSearchQuery / isTopicChannel) are exported + unit-tested in
// capture-sweep.test.ts; `main()` is
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
//   - On a 403 that survives the sticky session, retry the download once with
//     `--extractor-args youtube:player_client=tv,web_safari` before marking `failed`.
//   - On a BOT CHALLENGE ("Sign in to confirm you're not a bot" — an IP-reputation verdict
//     on the proxy exit, which no client fallback clears), re-roll the sticky session ONCE
//     per run (`<id>.r1`, a fresh residential exit) and retry; search and download share
//     the one re-roll, and a run challenged on both exits leaves the rest to backoff.
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
    (err as { is403?: boolean }).is403 = /HTTP Error 403|status code 403|\b403\b/.test(stderr);
    // DRM-locked or bot-walled: this specific VIDEO can't be pulled, but another candidate
    // for the same finding often can → the caller falls through to the next-ranked one.
    (err as { isRecoverable?: boolean }).isRecoverable =
      /DRM protected|Sign in to confirm|not a bot/i.test(stderr);
    (err as { isBotChallenge?: boolean }).isBotChallenge = isBotChallengeStderr(stderr);
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

  const primaryQuery = buildSearchQuery(finding, 0);
  const proxyUrl = buildStickyProxyUrl({
    host: PROXY_HOST,
    password: PROXY_PASSWORD,
    port: PROXY_PORT,
    sessionId: logId ?? trackId,
    username: PROXY_USERNAME,
  });
  // THE BOT-CHALLENGE RE-ROLL (one per run). A "Sign in to confirm you're not a bot" is an
  // IP-reputation verdict on the sticky exit — the answer is a DIFFERENT residential exit,
  // once, after which the run stays on the re-rolled session (a pool that challenges two
  // exits is cooling off; backoff owns the rest). `activeProxyUrl` is what every yt-dlp
  // call below uses; `rerollOnBotChallenge` flips it exactly once.
  const rerolledProxyUrl = buildStickyProxyUrl({
    host: PROXY_HOST,
    password: PROXY_PASSWORD,
    port: PROXY_PORT,
    sessionId: rerollSessionId(logId ?? trackId),
    username: PROXY_USERNAME,
  });
  let activeProxyUrl = proxyUrl;
  const rerollOnBotChallenge = (stage: string): boolean => {
    if (activeProxyUrl === rerolledProxyUrl) {
      return false;
    }
    log(`bot-challenged at ${stage} — re-rolling the proxy session for a fresh exit`);
    activeProxyUrl = rerolledProxyUrl;
    return true;
  };

  const dir = mkdtempSync(join(tmpdir(), "fluncle-capture-"));

  // The bad-audio memory lives OUTSIDE the try: a run that grew it and then errored still
  // persists it on the `failed` patch in the catch, so a paid-for rejection is never lost.
  let rejectedMemory: RejectedSource[] = parseRejectedSources(finding.sourceAudioRejected);
  let memoryDirty = false;

  try {
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
        candidates = runYtSearch(activeProxyUrl, rung.query, rung.source);
      } catch (error) {
        if (
          !(error as { isBotChallenge?: boolean }).isBotChallenge ||
          !rerollOnBotChallenge("search")
        ) {
          throw error;
        }
        candidates = runYtSearch(activeProxyUrl, rung.query, rung.source);
      }
      ranked = rankCandidates(candidates, rankContext);
      if (ranked.length > 0) {
        break;
      }
    }

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

    // ── THE BAD-AUDIO MEMORY (docs/the-ear.md § Wrong audio) ──────────────────────────────────
    // Two layers. The GENERAL memory (`source_audio_rejected`) drives a videoId PRE-download
    // filter + a sha256 POST-download backstop. The LEGACY single-sha (embedded in a kept
    // `source_audio_key`) is folded into the same backstop, so a row quarantined before the
    // general memory shipped still refuses its known-bad bytes. `memoryDirty` tracks whether this
    // run added a rejection, so the terminal write persists the grown memory exactly once.
    const rejectedIds = rejectedVideoIds(rejectedMemory);
    const knownBadShas = rejectedShas(rejectedMemory);
    const legacyRejectHash = extractSourceAudioSha256(finding.sourceAudioKey);
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
    // reference) is stored + stamped; a fingerprint MISMATCH rejects the candidate, remembers it,
    // and falls through to the next upload. A DRM/bot-walled hit is skipped (recoverable) but
    // keeps the run off the terminal `unmatched` (see below); a non-recoverable error aborts
    // (→ `failed`).
    let lastError: unknown;
    for (const candidate of attempts) {
      try {
        let file: { ext: string; path: string };
        try {
          file = runYtDownload(activeProxyUrl, candidate.candidate.id, dir, false);
        } catch (error) {
          if ((error as { is403?: boolean }).is403) {
            file = runYtDownload(activeProxyUrl, candidate.candidate.id, dir, true);
          } else if (
            (error as { isBotChallenge?: boolean }).isBotChallenge &&
            rerollOnBotChallenge("download")
          ) {
            // A fresh exit usually clears the challenge for the SAME candidate; if it
            // throws again the outer catch handles it as before (recoverable → next
            // candidate, since the run's one re-roll is now spent).
            file = runYtDownload(activeProxyUrl, candidate.candidate.id, dir, false);
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
          rejectedMemory = appendRejectedSource(rejectedMemory, {
            at: new Date().toISOString(),
            reason: "fingerprint-mismatch",
            sha256: fileDigest,
            videoId: candidate.candidate.id,
          });
          memoryDirty = true;
          knownBadShas.add(fileDigest);
          rmSync(file.path, { force: true });
          continue;
        }

        // MATCH → `preview-match`; NO-REFERENCE → `unverified` (the honest abstain). Store the
        // bytes + stamp the verdict provenance in the same write.
        const verification = verdict === "match" ? "preview-match" : "unverified";
        const key = buildSourceAudioKey(keyRoot, fileDigest, file.ext);

        await r2Put(key, fileBytes, contentTypeForExt(file.ext));

        // The key + done + the captured stamp + THE METER + THE VERIFICATION PROVENANCE.
        // Clobber-safe enrichment trigger — for a CERTIFIED finding, re-queue when the BPM is
        // missing OR the row was analyzed from a preview (closing the capture→enrich race; a
        // catalogue row has no enrichment and is skipped). `sourceAudioBytes` is the billed size,
        // knowable only HERE. `sourceAudioAttemptedAt` is stamped on success too (the budget's
        // rolling-24h ledger is a range seek on it). If this run REJECTED an earlier candidate,
        // the grown memory rides this write so it is never lost.
        const now = new Date().toISOString();
        const update: Record<string, unknown> = {
          captureStatus: "done",
          captureVerification: verification,
          captureVerifiedAt: now,
          sourceAudioAttemptedAt: now,
          sourceAudioBytes: fileBytes.byteLength,
          sourceAudioCapturedAt: now,
          sourceAudioKey: key,
        };
        if (memoryDirty) {
          update.sourceAudioRejected = JSON.stringify(rejectedMemory);
        }
        if (shouldReenrichAfterCapture(finding.certified, finding.bpm, finding.analyzedFrom)) {
          update.enrichmentStatus = "pending";
        }
        await patchTrack(trackId, update);

        return "done";
      } catch (error) {
        lastError = error;
        if ((error as { isRecoverable?: boolean }).isRecoverable) {
          log(`candidate ${candidate.candidate.id} unusable (DRM/bot-wall) — trying next`);
          continue;
        }
        throw error;
      }
    }

    // Nothing stored. `unmatched` (terminal — the queue never re-burns it; a fresh finding
    // still jumps it newest-first) is landed ONLY when the walk actually DISPROVED every
    // upload: each fresh candidate was WRONG AUDIO (known-bad or a fingerprint mismatch) or
    // wrong-length, or the pre-filter left nothing to try. A recoverable skip (DRM/bot-wall)
    // disproves nothing — the skipped upload can be the RIGHT audio (the 047.0.8M case: the
    // correct art-track bot-walled, two wrong songs fingerprint-rejected, and the rejections
    // masked the transient error into a terminal verdict) — so any `lastError` rethrows into
    // the retryable `failed` path, whose patch carries the grown memory too.
    if (!lastError) {
      const update: Record<string, unknown> = {
        captureStatus: "unmatched",
        sourceAudioAttemptedAt: new Date().toISOString(),
      };
      if (memoryDirty) {
        update.sourceAudioRejected = JSON.stringify(rejectedMemory);
      }
      await patchTrack(trackId, update);
      return "unmatched";
    }

    throw lastError;
  } catch (error) {
    // A yt-dlp / proxy / R2 error → failed (retriable under backoff). ACCUMULATE the
    // consecutive-failure count + stamp the attempt: the capture queue holds a `failed`
    // row out until `source_audio_attempted_at` is past the cooldown, and drops it once
    // the count hits the cap. The admin DTO surfaces the prior count (when non-zero), so
    // absent → 0 → a first failure lands 1, a second lands 2, … up to the cap.
    const priorFailures =
      typeof finding.sourceAudioFailures === "number" ? finding.sourceAudioFailures : 0;
    const update: Record<string, unknown> = {
      captureStatus: "failed",
      sourceAudioAttemptedAt: new Date().toISOString(),
      sourceAudioFailures: priorFailures + 1,
    };
    if (memoryDirty) {
      update.sourceAudioRejected = JSON.stringify(rejectedMemory);
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
