// fingerprint-match.ts — the CAPTURE VERIFICATION matcher (docs/the-ear.md § Wrong audio).
//
// THE DEFECT THIS EXISTS FOR. The capture sweep's yt-dlp search can return a same-label (or
// same-artist) upload whose AUDIO is a different song — and a length coincidence slips the
// duration guard (finding 005.9.9L: expected 198.6s, stored 246.9s off an Elevate Records
// channel video, caught in the 2026-07-12 capture audit). The wrong bytes are INAUDIBLE on every
// human surface — the site, the video, and the radio all play the ISRC-resolved OFFICIAL preview,
// never the captured file — so a wrong capture poisons only analysis, BPM/key, and the MuQ
// ranking space, silently. The operator's ruling: verify every captured file against that same
// official preview at ingest. The preview is ISRC-resolved, so it is the right recording BY
// CONSTRUCTION — the one reference that can answer "are these the same recording?".
//
// THE METHOD — Chromaprint, the standard practice. `fpcalc -raw -json` emits an acoustic
// fingerprint as a list of 32-bit integers, one per ~0.1238s frame (AcoustID/Chromaprint; Lukáš
// Lalinský, oxygene.sk/2011/01/how-does-chromaprint-work). Two fingerprints of the SAME recording,
// aligned, XOR to mostly-zero; two DIFFERENT recordings XOR to ~50% set bits (random). So the
// comparison is: align the two, then measure the BIT-ERROR RATE (fraction of differing bits) at
// the best alignment. The preview is a 30s excerpt of the full captured song, so its fingerprint
// should appear as a CONTIGUOUS WINDOW somewhere inside the capture's — a sliding-window minimum
// over every offset (`slidingWindowMatch` below).
//
// This module is PURE and side-effect free (the matcher + the fpcalc parse), and it is SHARED by
// the two consumers so they cannot drift: the capture sweep's ingest gate (capture-sweep.ts) and
// the historic backfill sweep (verify-captures.ts). The fpcalc SUBPROCESS + preview FETCH helpers
// live here too, so both consumers spawn fpcalc and resolve a preview the same way. Unit-tested in
// fingerprint-match.test.ts (the subprocess is mocked — CI has no fpcalc binary), which is why the
// pure matcher takes fingerprint ARRAYS, never a file path.
//
// FULL-AUDIO-ONLY is untouched. The preview is a verification REFERENCE and nothing else: it never
// feeds a vector, is never stored as analysis input, and never becomes the analyzed source. The
// ratified rule that embeddings/analysis use the captured FULL AUDIO or nothing stands — this
// module only READS the preview to decide whether the captured full audio is the right recording.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * THE THRESHOLD — the bit-error rate at (or below) which two fingerprints are the SAME recording.
 *
 * Chromaprint's frames are 32-bit, so the BER of one aligned window is `popcount(XOR) / (32 ×
 * frames)` — 0 for identical audio, ~0.5 for unrelated audio (a random XOR sets ~half the bits).
 * The two regimes are far apart, which is what makes a single threshold safe.
 *
 * Standard AcoustID/Picard practice treats **BER < 0.15** (≥ 85% of bits agreeing at the best
 * alignment) as a confident same-recording match. We deliberately widen it to **0.20** because
 * our two inputs come from DIFFERENT SOURCES — a Deezer/Apple 30s preview vs a YouTube full-song
 * capture — with different codecs and loudness normalization, which nudges a genuine match's BER
 * up a few points. 0.20 keeps a wide margin below the different-recording regime (~0.45+) while
 * never FALSE-REJECTING a true match on a cross-source encoding difference — a false rejection
 * would quarantine a correct capture and cost the operator a re-verify, so caution runs toward
 * accepting. Env-overridable (`FLUNCLE_VERIFY_MAX_BER`) so the operator can tighten or relax it
 * without a re-bake. Sources dated 2026-07-13 (Chromaprint/AcoustID matching practice).
 */
export const DEFAULT_MAX_BER = 0.2;

/**
 * The env-resolved threshold. Read once per process. A malformed/out-of-range value degrades to
 * the documented default rather than silently disabling the gate (a NaN threshold would make
 * every comparison "match", the worst failure for a safety gate).
 */
export function maxBer(): number {
  const raw = Number(process.env.FLUNCLE_VERIFY_MAX_BER ?? "");

  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : DEFAULT_MAX_BER;
}

/**
 * The minimum overlap (in fingerprint frames) a windowed comparison must have to be trustworthy.
 * A handful of frames can align spuriously low by chance, so a preview fingerprint shorter than
 * this yields an INCONCLUSIVE verdict (the caller abstains → `unverified`), never a false match.
 * ~30 frames ≈ 3.7s of audio — comfortably below a 30s preview's ~240 frames, so it only ever
 * bites a degenerate/truncated fingerprint.
 */
export const MIN_OVERLAP_FRAMES = 30;

/** popcount of a 32-bit integer (Hamming weight) — the number of set bits. */
export function popcount32(value: number): number {
  let v = value | 0;
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;

  return ((v * 0x01010101) >>> 24) & 0xff;
}

/** The best-alignment bit-error verdict of one sliding-window comparison. */
export type MatchResult = {
  /** The bit-error rate at the best alignment (0 = identical, ~0.5 = unrelated). */
  ber: number;
  /** Whether `ber <= threshold` — the same-recording verdict. */
  match: boolean;
  /** Frames overlapped at the best alignment (the window length). */
  overlap: number;
};

/**
 * Slide the SHORTER fingerprint across the LONGER one and return the MINIMUM bit-error rate over
 * every contiguous alignment. This is the "is the preview contained in the capture" test: the
 * preview is a 30s excerpt somewhere inside the full song, so a genuine match has one offset where
 * the windows XOR to near-zero, wherever in the track the excerpt was taken from.
 *
 * `null` when either fingerprint is empty or the shorter one is below `MIN_OVERLAP_FRAMES` — an
 * INCONCLUSIVE comparison, which the caller treats as "cannot verify" (abstain), never as a match.
 *
 * O(shorter × (longer − shorter)) — a 30s preview (~240 frames) over a 5-minute capture (~2400
 * frames) is ~500k frame-XORs, sub-millisecond. Bounded and fine to run per-track.
 */
export function slidingWindowMatch(
  a: readonly number[],
  b: readonly number[],
  threshold: number = maxBer(),
): MatchResult | null {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];

  if (short.length < MIN_OVERLAP_FRAMES || long.length === 0) {
    return null;
  }

  const window = short.length;
  const totalBits = window * 32;
  let bestBits = Number.POSITIVE_INFINITY;

  for (let offset = 0; offset + window <= long.length; offset += 1) {
    let bits = 0;

    for (let index = 0; index < window; index += 1) {
      // `| 0` coerces to a 32-bit int so `^` matches fpcalc's raw uint32 semantics.
      bits += popcount32((short[index] ?? 0) ^ (long[offset + index] ?? 0));

      // Early exit: this offset already lost to the best so far.
      if (bits >= bestBits) {
        break;
      }
    }

    if (bits < bestBits) {
      bestBits = bits;
    }
  }

  const ber = bestBits / totalBits;

  return { ber, match: ber <= threshold, overlap: window };
}

/**
 * Parse `fpcalc -raw -json` stdout into the raw fingerprint array. fpcalc prints
 * `{"duration": <s>, "fingerprint": [<int>, …]}` for `-raw`. Returns null on any shape it does not
 * recognise, so a fpcalc quirk degrades to "no fingerprint" (abstain) rather than a thrown tick.
 */
export function parseFpcalcJson(stdout: string): number[] | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }

  const fingerprint = (parsed as { fingerprint?: unknown } | null)?.fingerprint;

  if (!Array.isArray(fingerprint) || fingerprint.length === 0) {
    return null;
  }

  const out: number[] = [];

  for (const entry of fingerprint) {
    const value = Number(entry);

    if (!Number.isFinite(value)) {
      return null;
    }

    out.push(value | 0);
  }

  return out;
}

/**
 * Fingerprint one audio file with `fpcalc -raw -json`. Returns the raw array, or null when fpcalc
 * is ABSENT (the box has not been re-baked with chromaprint yet) or FAILS (a bad decode). Both
 * degrade HONESTLY: the caller stamps `unverified` and never crashes the tick, so the repo half is
 * safe to ship before the image carries fpcalc. The binary path is `FPCALC_BIN` (default `fpcalc`).
 */
export function fpcalcFingerprint(
  filePath: string,
  bin: string = process.env.FPCALC_BIN ?? "fpcalc",
): number[] | null {
  let result: ReturnType<typeof spawnSync>;

  try {
    result = spawnSync(bin, ["-raw", "-json", filePath], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    });
  } catch {
    return null;
  }

  // ENOENT (fpcalc not installed) surfaces as `result.error`; a decode failure as a nonzero status.
  if (result.error || result.status !== 0) {
    return null;
  }

  return parseFpcalcJson(result.stdout ?? "");
}

/**
 * Fetch a track's official 30s preview through the SAME public `/api/preview/:idOrLogId` relay the
 * site/radio/video use (Deezer → Apple → iTunes, ISRC-resolved), then fingerprint the bytes. The
 * bytes are written to a scratch file (fpcalc reads a path, not a stream) and deleted immediately.
 *
 * Returns the fingerprint, or null when the track has NO preview source (the gate then ABSTAINS →
 * `unverified`, never a block on a track with no reference) or fpcalc is absent/failing. `idOrLogId`
 * is a track id or a Log ID — the relay resolves a catalogue row (LEFT join) or a finding alike.
 */
export async function fetchPreviewFingerprint(options: {
  apiBaseUrl: string;
  apiToken?: string;
  fpcalcBin?: string;
  idOrLogId: string;
}): Promise<number[] | null> {
  const url = `${options.apiBaseUrl}/api/preview/${encodeURIComponent(options.idOrLogId)}`;
  const headers: Record<string, string> = {};

  // The preview relay is a PUBLIC route (no auth), but sending the box's bearer is harmless and
  // keeps every box→API call uniform. Omitted when there is no token.
  if (options.apiToken) {
    headers.Authorization = `Bearer ${options.apiToken}`;
  }

  let res: Response;

  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  } catch {
    return null;
  }

  // 404 / no_preview ⇒ the track has no reference clip. Abstain, do not throw.
  if (!res.ok) {
    return null;
  }

  const bytes = new Uint8Array(await res.arrayBuffer());

  if (bytes.byteLength === 0) {
    return null;
  }

  const dir = mkdtempSync(join(tmpdir(), "fluncle-verify-"));
  const path = join(dir, "preview.mp3");

  try {
    writeFileSync(path, bytes);

    return fpcalcFingerprint(path, options.fpcalcBin);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

// ── THE SECOND REFERENCE-RESOLUTION RUNG — TITLE + ARTIST (docs/the-ear.md § Wrong audio) ──────
//
// THE GAP THIS CLOSES. The rung above (`fetchPreviewFingerprint`) resolves the reference through
// the `/api/preview` relay, which is ISRC-keyed: a fresh Deezer, then exact-Apple, then a loose
// fuzzy-iTunes playback fallback. A captured row with `isrc IS NULL` and no stored preview can
// never reach a TRUSTWORTHY reference that way, so the historic backfill leaves it `unverified`
// forever — ~221 rows the ground-truth sample says are almost certainly clean. This rung resolves a
// candidate preview for exactly those rows by TITLE + ARTIST search against an allowed preview
// source (the keyless iTunes Search API — an allowed source per the audio-source policy, the same
// source the relay's playback fallback uses).
//
// PRECISION OVER RECALL — this is the whole point. A wrong reference preview would manufacture a
// FALSE mismatch and (on a catalogue row) quarantine good audio, which is strictly worse than
// leaving a row unverified. So the reference this rung hands back is trusted only when it clears
// three guards, and even then it can only ever CONFIRM a capture, never CONDEMN it (the box maps a
// search-reference mismatch to the honest abstain — verify-captures.ts):
//   1. IDENTITY — the hit's folded `matchKey` (artist SET + base title + version descriptor) must
//      EQUAL the row's. A fuzzy/partial match is a NON-match. Same discipline as the Rekordbox
//      sync + the plan→recording backfill (apps/web/src/lib/server/track-match.ts, itself the port
//      of packages/skills/fluncle-rekordbox-sync/scripts/rekordbox_sync.py). Replicated below
//      because a box script cannot import the workspace.
//   2. DURATION — the hit's reported length must agree with the row's `duration_ms` within the
//      capture tolerance (replicated from capture-sweep.ts's `durationWithinTolerance` /
//      TOLERANCE_SEC / TOLERANCE_PCT, same env knobs, same defaults).
//   3. UNAMBIGUOUS — zero confident hits, or several that disagree on length, resolve to NOTHING
//      (the honest abstain). Never a guess.

// The keyless iTunes Search API — the courtesy pace (1 req/s, the MusicBrainz-client precedent) and
// the hit limit are env-overridable so the operator can tune them without a re-bake.
const ITUNES_SEARCH_URL = "https://itunes.apple.com/search";
const ITUNES_MIN_INTERVAL_MS = Number(process.env.FLUNCLE_ITUNES_MIN_INTERVAL_MS ?? "1000");
const ITUNES_SEARCH_LIMIT = Number(process.env.FLUNCLE_ITUNES_SEARCH_LIMIT ?? "15");

// The duration match-guard's tolerance — REPLICATED from capture-sweep.ts (a box script is
// self-contained; keep these in step with that file). Accept a candidate only within
// max(toleranceSec, targetSec × tolerancePct) of the row's stored length.
const TOLERANCE_SEC = Number(process.env.FLUNCLE_CAPTURE_TOLERANCE_SEC ?? "3");
const TOLERANCE_PCT = Number(process.env.FLUNCLE_CAPTURE_TOLERANCE_PCT ?? "0.03");

/**
 * True when `candidateSec` is within tolerance of the target length. REPLICATED from
 * capture-sweep.ts's `durationWithinTolerance` (identical semantics) — a box script cannot import
 * the workspace. A non-positive/absent target abstains (returns false): with no length to guard
 * against, the reference cannot be trusted.
 */
export function durationAgrees(
  candidateSec: number,
  targetMs: number | undefined,
  options: { tolerancePct: number; toleranceSec: number } = {
    tolerancePct: TOLERANCE_PCT,
    toleranceSec: TOLERANCE_SEC,
  },
): boolean {
  if (!Number.isFinite(candidateSec) || candidateSec <= 0 || !targetMs || targetMs <= 0) {
    return false;
  }

  const targetSec = targetMs / 1000;
  const allowed = Math.max(options.toleranceSec, targetSec * options.tolerancePct);

  return Math.abs(candidateSec - targetSec) <= allowed;
}

// ── The folded-identity matcher — REPLICATED from apps/web/src/lib/server/track-match.ts ───────
// (which is itself the TS port of rekordbox_sync.py's `_fold` / `_normalize_artists` /
// `_split_title` / `match_key`). A box script cannot import the workspace, so the minimal fold is
// carried here; keep it in step with track-match.ts. A REMIX / VIP / edit is a DIFFERENT recording
// — its descriptor is part of the identity — so "Song (Calibre Remix)" never matches the original.

const VERSION_WORDS = new Set([
  "bootleg",
  "dub",
  "edit",
  "extended",
  "flip",
  "instrumental",
  "mix",
  "refix",
  "remaster",
  "remix",
  "rework",
  "rmx",
  "version",
  "vip",
]);
const NEUTRAL_DESCRIPTORS = new Set(["original mix", "original", "extended mix"]);
const ARTIST_SPLIT = /\s*(?:,|&|\/|\band\b|\bx\b|\bvs\b|\bversus\b|\bwith\b)\s*/;
const FEAT_INLINE = /\b(?:feat|ft|featuring)\b\.?.*$/i;
const PUNCT = /[^a-z0-9 ]+/g;
const WS = /\s+/g;

function stripAccents(text: string): string {
  return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

/** Lowercase, strip accents, fold `&`→`and`, drop punctuation, collapse spaces. */
export function fold(text: string): string {
  const folded = stripAccents(text).toLowerCase().replaceAll("&", " and ");

  return folded.replace(PUNCT, " ").replace(WS, " ").trim();
}

/** The set of individual, folded artist names — order- and separator-agnostic; drops `feat.`. */
export function normalizeArtists(artists: string[] | string): Set<string> {
  const raw = (Array.isArray(artists) ? artists.join(", ") : artists).replace(FEAT_INLINE, "");
  const names = new Set<string>();

  for (const part of raw.split(ARTIST_SPLIT)) {
    const name = fold(part);

    if (name) {
      names.add(name);
    }
  }

  return names;
}

/** `(base title, version descriptor)` — base with feat./mix suffixes removed, descriptor distinguishing. */
export function splitTitle(title: string): { base: string; descriptor: string } {
  let working = title;
  let descriptor = "";

  const groups = [...working.matchAll(/[([]([^)\]]*)[)\]]/g)];

  for (const match of groups.reverse()) {
    const start = match.index;
    const end = start + match[0].length;
    const foldedInner = fold(match[1] ?? "");

    if (!foldedInner) {
      working = working.slice(0, start) + working.slice(end);
      continue;
    }

    if (/^(?:feat|ft|featuring)\b/.test(foldedInner)) {
      working = working.slice(0, start) + working.slice(end);
      continue;
    }

    const tokens = new Set(foldedInner.split(" "));
    const isVersion = [...tokens].some((token) => VERSION_WORDS.has(token));

    if (isVersion && !NEUTRAL_DESCRIPTORS.has(foldedInner)) {
      descriptor = foldedInner;
    }

    working = working.slice(0, start) + working.slice(end);
  }

  const dash = working.match(/\s[-–—]\s(.+)$/);

  if (dash && dash.index !== undefined) {
    const foldedSuffix = fold(dash[1] ?? "");
    const suffixTokens = new Set(foldedSuffix.split(" "));

    if ([...suffixTokens].some((token) => VERSION_WORDS.has(token))) {
      if (!NEUTRAL_DESCRIPTORS.has(foldedSuffix) && !descriptor) {
        descriptor = foldedSuffix;
      }

      working = working.slice(0, dash.index);
    }
  }

  working = working.replace(FEAT_INLINE, "");

  return { base: fold(working), descriptor };
}

/** The identity two rows must share to be the same recording, as a stable string key. */
export function matchKey(artists: string[] | string, title: string): string {
  const { base, descriptor } = splitTitle(title);
  const names = [...normalizeArtists(artists)].sort();

  return JSON.stringify([names, base, descriptor]);
}

// ── The iTunes rung ─────────────────────────────────────────────────────────────────────────

/** One parsed iTunes Search hit — only the fields the guards read. */
export type ItunesReference = {
  artistName: string;
  durationSec: number;
  previewUrl: string;
  trackName: string;
};

// 1 req/s courtesy pace, module-scoped so every search across a tick honours it (MusicBrainz-client
// precedent). Best-effort — a single-process box, so a plain gate is enough.
let itunesNextAllowedAt = 0;

async function itunesThrottle(): Promise<void> {
  const now = Date.now();
  const wait = itunesNextAllowedAt - now;

  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }

  itunesNextAllowedAt = Math.max(now, itunesNextAllowedAt) + ITUNES_MIN_INTERVAL_MS;
}

/**
 * Search the keyless iTunes Search API for a term, returning the parsed hits that carry a preview
 * URL + a usable duration. Never throws: any network/parse failure degrades to `[]` (the caller
 * abstains). Paced to `ITUNES_MIN_INTERVAL_MS`. Exported so the box wires it as the real search
 * effect; the pure guard (`pickSearchReference`) is what the unit tests drive.
 */
export async function searchItunesReferences(term: string): Promise<ItunesReference[]> {
  const query = term.trim();

  if (!query) {
    return [];
  }

  await itunesThrottle();

  const url = `${ITUNES_SEARCH_URL}?term=${encodeURIComponent(
    query,
  )}&media=music&entity=song&limit=${Math.max(1, Math.trunc(ITUNES_SEARCH_LIMIT))}`;

  let res: Response;

  try {
    res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return [];
  }

  if (!res.ok) {
    return [];
  }

  let body: { results?: unknown };

  try {
    body = (await res.json()) as { results?: unknown };
  } catch {
    return [];
  }

  const results = Array.isArray(body.results) ? body.results : [];
  const out: ItunesReference[] = [];

  for (const entry of results) {
    const hit = entry as {
      artistName?: unknown;
      previewUrl?: unknown;
      trackName?: unknown;
      trackTimeMillis?: unknown;
    };

    if (
      typeof hit.previewUrl !== "string" ||
      !hit.previewUrl ||
      typeof hit.trackName !== "string" ||
      typeof hit.artistName !== "string" ||
      typeof hit.trackTimeMillis !== "number" ||
      !Number.isFinite(hit.trackTimeMillis)
    ) {
      continue;
    }

    out.push({
      artistName: hit.artistName,
      durationSec: hit.trackTimeMillis / 1000,
      previewUrl: hit.previewUrl,
      trackName: hit.trackName,
    });
  }

  return out;
}

/** The row the guards resolve a reference FOR. */
export type SearchTarget = {
  artists: string[];
  durationMs?: number;
  title: string;
};

/** The pure guard's verdict: the confident preview URL, or an honest abstain with its reason. */
export type SearchPick =
  | { previewUrl: null; reason: "conflict" | "no-hit" }
  | { previewUrl: string };

/**
 * THE PRECISION HEART (pure, unit-tested). Given a row and the search hits, pick the ONE confident
 * reference preview, or abstain:
 *   - keep only hits whose folded `matchKey` EQUALS the row's (guard 1) AND whose duration agrees
 *     with the row's `duration_ms` (guard 2);
 *   - zero survivors ⇒ `no-hit` (covers no results, an identity-mismatch hit, a duration-disagree
 *     hit — each rejected as a reference, never a guess);
 *   - survivors that disagree on length with each other beyond the tolerance ⇒ `conflict` (two
 *     genuinely different recordings share the title+artist — we cannot tell which the row is);
 *   - otherwise the closest-length survivor's preview URL. Multiple survivors that agree on length
 *     are the same recording on different releases — any is an equally good fingerprint reference.
 */
export function pickSearchReference(
  hits: readonly ItunesReference[],
  target: SearchTarget,
): SearchPick {
  if (!target.durationMs || target.durationMs <= 0) {
    // No length to guard against ⇒ the duration guard cannot run ⇒ never trust a reference.
    return { previewUrl: null, reason: "no-hit" };
  }

  const rowKey = matchKey(target.artists, target.title);
  const accepted = hits.filter(
    (hit) =>
      hit.previewUrl.trim() !== "" &&
      matchKey([hit.artistName], hit.trackName) === rowKey &&
      durationAgrees(hit.durationSec, target.durationMs),
  );

  if (accepted.length === 0) {
    return { previewUrl: null, reason: "no-hit" };
  }

  const sorted = [...accepted].sort(
    (a, b) =>
      Math.abs(a.durationSec - target.durationMs / 1000) -
      Math.abs(b.durationSec - target.durationMs / 1000),
  );
  const [primary, ...rest] = sorted;

  if (!primary) {
    return { previewUrl: null, reason: "no-hit" };
  }

  // Any surviving hit whose length disagrees with the primary's is a DIFFERENT recording that
  // happens to share the title+artist — we cannot tell which one the row's capture is. Abstain.
  const conflict = rest.some((hit) => !durationAgrees(hit.durationSec, primary.durationSec * 1000));

  if (conflict) {
    return { previewUrl: null, reason: "conflict" };
  }

  return { previewUrl: primary.previewUrl };
}

/** The resolved reference fingerprint, or an honest abstain with its reason. */
export type SearchReferenceResult =
  | { fingerprint: null; reason: "conflict" | "no-hit" | "no-preview-audio" }
  | { fingerprint: number[] };

/**
 * The full TITLE + ARTIST rung: search → apply the guards → fetch the confident preview's bytes →
 * fingerprint them. Returns the fingerprint, or an abstain reason (`no-hit`/`conflict` from the
 * guard, `no-preview-audio` when the confident preview could not be fetched/decoded). `search` is
 * injectable so tests drive the pure path without network; production wires `searchItunesReferences`.
 *
 * This is a LOWER-TRUST reference than the ISRC rung by construction (title+artist, not a byte-exact
 * ISRC), so the box only ever lets it CONFIRM a capture — a mismatch against it abstains, never
 * condemns (verify-captures.ts). The preview is a verification REFERENCE only: never a vector, never
 * a stored analysis input (full-audio-only is ratified).
 */
export async function resolveSearchPreviewFingerprint(options: {
  artists: string[];
  durationMs?: number;
  fpcalcBin?: string;
  search?: (term: string) => Promise<ItunesReference[]>;
  title: string;
}): Promise<SearchReferenceResult> {
  const artist = options.artists[0]?.trim();
  const title = options.title.trim();

  if (!artist || !title || !options.durationMs || options.durationMs <= 0) {
    return { fingerprint: null, reason: "no-hit" };
  }

  const search = options.search ?? searchItunesReferences;
  const hits = await search(`${artist} ${title}`);
  const pick = pickSearchReference(hits, {
    artists: options.artists,
    durationMs: options.durationMs,
    title: options.title,
  });

  if (pick.previewUrl === null) {
    return { fingerprint: null, reason: pick.reason };
  }

  let res: Response;

  try {
    res = await fetch(pick.previewUrl, { signal: AbortSignal.timeout(30_000) });
  } catch {
    return { fingerprint: null, reason: "no-preview-audio" };
  }

  if (!res.ok) {
    return { fingerprint: null, reason: "no-preview-audio" };
  }

  const bytes = new Uint8Array(await res.arrayBuffer());

  if (bytes.byteLength === 0) {
    return { fingerprint: null, reason: "no-preview-audio" };
  }

  const dir = mkdtempSync(join(tmpdir(), "fluncle-verify-search-"));
  const path = join(dir, "preview.m4a");

  try {
    writeFileSync(path, bytes);

    const fingerprint = fpcalcFingerprint(path, options.fpcalcBin);

    return fingerprint === null
      ? { fingerprint: null, reason: "no-preview-audio" }
      : { fingerprint };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

/** One entry in a track's bad-audio memory (`tracks.source_audio_rejected`). */
export type RejectedSource = {
  /** ISO when this source was rejected. */
  at: string;
  /** Why it was rejected (a fingerprint mismatch, a known-bad re-download, a quarantine). */
  reason: string;
  /** The captured file's sha256 — the deep backstop (same audio re-uploaded under a new id). */
  sha256: string;
  /** The YouTube video id, when known — the cheap PRE-download filter (never re-buy its bytes). */
  videoId?: string;
};

/** The cap on the bad-audio memory — the newest N entries, oldest dropped (docs/the-ear.md). */
export const REJECTED_MEMORY_CAP = 10;

/**
 * Append a rejected source to a track's bad-audio memory, capped at the newest `REJECTED_MEMORY_CAP`
 * (oldest dropped). Deduped on `(videoId, sha256)` so re-flagging the same bad master does not
 * evict good entries. PURE — it returns the next array; the caller persists it. This is the shared
 * authority both the sweep's pre-download filter and the post-download sha backstop read against.
 */
export function appendRejectedSource(
  existing: readonly RejectedSource[] | null | undefined,
  entry: RejectedSource,
): RejectedSource[] {
  const prior = (existing ?? []).filter(
    (row) => !(row.sha256 === entry.sha256 && (row.videoId ?? "") === (entry.videoId ?? "")),
  );

  return [...prior, entry].slice(-REJECTED_MEMORY_CAP);
}

/** Parse a stored `source_audio_rejected` JSON string/array into typed rows (tolerant of junk). */
export function parseRejectedSources(value: unknown): RejectedSource[] {
  const raw = typeof value === "string" ? safeJsonArray(value) : Array.isArray(value) ? value : [];
  const out: RejectedSource[] = [];

  for (const entry of raw) {
    const row = entry as Partial<RejectedSource> | null;

    if (row && typeof row.sha256 === "string" && typeof row.at === "string") {
      out.push({
        at: row.at,
        reason: typeof row.reason === "string" ? row.reason : "rejected",
        sha256: row.sha256,
        ...(typeof row.videoId === "string" ? { videoId: row.videoId } : {}),
      });
    }
  }

  return out;
}

function safeJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);

    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** The set of rejected video ids — the sweep's PRE-download candidate filter. */
export function rejectedVideoIds(rejected: readonly RejectedSource[]): Set<string> {
  const ids = new Set<string>();

  for (const row of rejected) {
    if (row.videoId) {
      ids.add(row.videoId);
    }
  }

  return ids;
}

/** The set of rejected sha256 digests — the sweep's POST-download bytes backstop. */
export function rejectedShas(rejected: readonly RejectedSource[]): Set<string> {
  return new Set(rejected.map((row) => row.sha256));
}
