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
