// Set analysis (Unit B of the Fluncle Studio RFC) — turn a long DJ-set audio file
// into a `StudioEnvelope`: full-length energy/bass/flux curves (decimated to a
// ~100ms display hop) + a ranked list of candidate "drop" windows the operator vets.
//
// Reuses the shared DSP kernel (audio-curves.ts: computeBands / onsetEnvelope / the
// normalizers) and the render path's BPM/grid/onset helpers (analyze-audio.ts), so
// this file owns only what is genuinely NEW for a set:
//
//   1. A STREAMING ffmpeg decode at 11025Hz. A 48-min set is ~190MB if you readFile
//      the whole WAV into a Buffer AND a Float32Array at once; we pipe ffmpeg's raw
//      s16le stdout and convert chunk-by-chunk into a single pre-sized Float32Array
//      (never the byte buffer + the float array coexisting).
//   2. A TOP-N DROP PICKER (new logic — NOT the render path's single-window kernel,
//      which nudges a FIXED ~400ms, not a bar): drop-novelty scoring, LOCAL/windowed
//      max-normalization (a global max buries quieter good drops), spacing-deduped
//      peak-picking, a LOCAL per-peak tempo/phase snap (a single global BPM drifts on
//      a multi-tempo set), and a musical pre-roll so the drop lands just inside.
//
// The candidates are LOUDNESS-RISE candidates, tagged `kind: "drop"` — they are NOT
// certainties: a soft re-entry (a quiet pad swelling back in) false-positives. The
// operator vets them in the editor (Unit E).

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

import {
  type Bands,
  HOP_MS,
  computeBands,
  normalizeBandsShared,
  normalizeInPlace,
  onsetEnvelope,
} from "./audio-curves";
import { bestPhaseGrid, estimateBpm, pickOnsets } from "./analyze-audio";

// ffmpeg/ffprobe on PATH by default (mirrors download-preview.ts's FLUNCLE_FFMPEG).
const FFMPEG = process.env.FLUNCLE_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FLUNCLE_FFPROBE ?? "ffprobe";

// 11025Hz: Nyquist 5.5kHz is ample for a bass-keyed drop picker, and it halves the
// sample memory vs 22050. The 20ms analysis hop (HOP_MS) is shared with the render
// path; only the OUTPUT curve is decimated to the display hop below.
const SET_SAMPLE_RATE = 11025;
const DISPLAY_HOP_MS = 100;

// Picker defaults (all overridable). A bar at 174 BPM ≈ 1.38s; the pre/post novelty
// windows are ~2 bars so a breakdown→slam reads cleanly.
const DEFAULT_SUGGESTION_MS = 15_000;
const DEFAULT_TOP_N = 8;
const DEFAULT_MIN_PEAK_SPACING_MS = 35_000; // 30–45s inter-peak spacing
const NOVELTY_PRE_MS = 3_000; // the breakdown before the drop
const NOVELTY_POST_MS = 3_000; // the slam after the drop
const REENTRY_FLUX_MS = 800; // the re-entry transient window
const BAR_SMOOTH_MS = 1_400; // bar-scale bass smoothing
const LOCAL_NORM_HALF_MS = 30_000; // ±30s local max-normalization window
const LOCAL_TEMPO_HALF_MS = 8_000; // ±8s local tempo/phase window for the snap
const DROP_SCORE_WEIGHT = 1.0; // λ on dropScore in the final ranking
const MULTI_TEMPO_TOLERANCE_BPM = 4; // local-BPM spread above this ⇒ global bpm = null

/** A loudness-rise candidate. `kind: "drop"` is a guess, not a certainty (see file header). */
export type StudioPeak = {
  atMs: number;
  score: number;
  kind: "drop";
};

/** A vettable clip window: the drop lands at `anchorMs`, just inside `startMs`. */
export type StudioSuggestion = {
  startMs: number;
  durationMs: number;
  anchorMs: number;
  score: number;
};

/**
 * The set-analysis artifact (Unit E consumes it). The 20ms analysis stays internal;
 * only the decimated `hopMs` curve crosses the wire. `bpm` is null on a multi-tempo
 * set (a single global grid would drift — the per-peak local snap is used instead).
 */
export type StudioEnvelope = {
  durationMs: number;
  hopMs: number;
  bpm: number | null;
  energy: number[];
  bass: number[];
  flux: number[];
  peaks: StudioPeak[];
  suggestions: StudioSuggestion[];
};

export type AnalyzeSetOptions = {
  sampleRate?: number;
  displayHopMs?: number;
  suggestionMs?: number;
  topN?: number;
  minPeakSpacingMs?: number;
};

// ---------------------------------------------------------------------------
// Streaming decode
// ---------------------------------------------------------------------------

/** ffprobe the container duration (seconds) so the PCM buffer can be pre-sized. */
async function probeDurationSec(setPath: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(FFPROBE, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nokey=1:noprint_wrappers=1",
      setPath,
    ]);
    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString();
    });
    // Best-effort: a failed/absent probe just falls back to the grow path below.
    child.on("error", () => resolve(0));
    child.on("close", () => {
      const n = Number.parseFloat(out.trim());
      resolve(Number.isFinite(n) && n > 0 ? n : 0);
    });
  });
}

/**
 * Decode `setPath` to mono Float32 PCM at `sampleRate`, STREAMING from ffmpeg's raw
 * s16le stdout. We pre-size the Float32Array from ffprobe's duration and fill it
 * chunk-by-chunk (growing if the probe under-shot), so the multi-GB byte buffer is
 * never materialized — only the float array exists, and each ffmpeg chunk is dropped
 * the moment its samples are copied out.
 */
async function decodeSetMono(setPath: string, sampleRate: number): Promise<Float32Array> {
  const durationSec = await probeDurationSec(setPath);
  // +2s margin so a slightly-short probe doesn't force an early grow.
  let samples = new Float32Array(Math.max(sampleRate, Math.ceil((durationSec + 2) * sampleRate)));
  let count = 0;
  let leftover = -1; // a stray low byte carried across a chunk boundary, or -1

  const push = (v: number): void => {
    if (count >= samples.length) {
      const grown = new Float32Array(Math.ceil(samples.length * 1.5) + sampleRate);
      grown.set(samples);
      samples = grown;
    }
    samples[count++] = v;
  };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      FFMPEG,
      [
        "-v",
        "error",
        "-i",
        setPath,
        "-ac",
        "1",
        "-ar",
        String(sampleRate),
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stderr = "";
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });

    child.stdout.on("data", (chunk: Buffer) => {
      const end = chunk.length;
      let i = 0;
      // Reassemble a sample split across the previous chunk boundary.
      if (leftover >= 0 && end > 0) {
        const raw = leftover | (chunk[0] << 8);
        push((raw >= 0x8000 ? raw - 0x10000 : raw) / 32768);
        leftover = -1;
        i = 1;
      }
      // Whole little-endian s16 pairs.
      for (; i + 1 < end; i += 2) {
        push(chunk.readInt16LE(i) / 32768);
      }
      // A lone trailing byte carries to the next chunk.
      if (i < end) {
        leftover = chunk[i];
      }
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${FFMPEG} exited with ${code}\n${stderr.slice(-2000)}`));
      }
    });
  });

  return count === samples.length ? samples : samples.subarray(0, count);
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

/** Box-blur moving average via a prefix sum — O(n), window = 2*halfWin+1 hops. */
function movingAverage(arr: Float32Array, halfWin: number): Float32Array {
  const n = arr.length;
  const out = new Float32Array(n);
  if (n === 0) {
    return out;
  }
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    prefix[i + 1] = prefix[i] + arr[i];
  }
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - halfWin);
    const hi = Math.min(n - 1, i + halfWin);
    out[i] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
  }
  return out;
}

/**
 * Centred sliding-window max via a monotonic deque — O(n), window
 * [c-halfWin, c+halfWin] (clamped at the edges). The deque holds indices in
 * value-decreasing order; `head` is a pointer so neither end is an O(n) shift.
 */
function slidingMax(arr: Float32Array, halfWin: number): Float32Array {
  const n = arr.length;
  const out = new Float32Array(n);
  if (n === 0) {
    return out;
  }
  const dq: number[] = []; // indices; arr[dq[head..]] is decreasing
  let head = 0;
  // Centre c is finalized when j reaches c+halfWin; we emit it then.
  for (let j = 0; j < n; j++) {
    while (head < dq.length && arr[dq[dq.length - 1]] <= arr[j]) {
      dq.pop();
    }
    dq.push(j);
    const c = j - halfWin;
    if (c >= 0) {
      while (head < dq.length && dq[head] < c - halfWin) {
        head++;
      }
      out[c] = arr[dq[head]];
    }
  }
  // Flush the trailing centres whose right edge ran off the end (upper bound = n-1).
  for (let c = Math.max(0, n - halfWin); c < n; c++) {
    while (head < dq.length && dq[head] < c - halfWin) {
      head++;
    }
    out[c] = head < dq.length ? arr[dq[head]] : 0;
  }
  return out;
}

function meanRange(arr: Float32Array, fromHop: number, toHop: number): number {
  const lo = Math.max(0, fromHop);
  const hi = Math.min(arr.length - 1, toHop);
  if (hi < lo) {
    return 0;
  }
  let s = 0;
  for (let i = lo; i <= hi; i++) {
    s += arr[i];
  }
  return s / (hi - lo + 1);
}

/** Average groups of `factor` hops to decimate a 20ms curve to the display hop. */
function decimate(arr: Float32Array, factor: number): number[] {
  if (factor <= 1) {
    return Array.from(arr, (v) => Number(v.toFixed(4)));
  }
  const out: number[] = [];
  for (let i = 0; i + factor <= arr.length; i += factor) {
    let s = 0;
    for (let j = 0; j < factor; j++) {
      s += arr[i + j];
    }
    out.push(Number((s / factor).toFixed(4)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The picker (NEW logic — see file header)
// ---------------------------------------------------------------------------

export type PickResult = {
  bpm: number | null;
  peaks: StudioPeak[];
  suggestions: StudioSuggestion[];
};

/**
 * Estimate a global BPM, or null if the set is multi-tempo. We sample the local
 * tempo in evenly spaced ±8s windows; if the spread exceeds the tolerance the set
 * has no single grid and we return null (the per-peak local snap is used instead).
 */
function estimateGlobalBpm(flux: Float32Array): number | null {
  const half = Math.round(LOCAL_TEMPO_HALF_MS / HOP_MS);
  const span = half * 2;
  if (flux.length < span) {
    return null;
  }
  const probes: number[] = [];
  // ~12 probes across the set (at least the start, middle, end).
  const probeCount = Math.max(3, Math.min(12, Math.floor(flux.length / span)));
  for (let p = 0; p < probeCount; p++) {
    const centre = Math.round(((p + 0.5) / probeCount) * flux.length);
    const lo = Math.max(0, centre - half);
    const hi = Math.min(flux.length, lo + span);
    const slice = flux.subarray(lo, hi);
    if (slice.length >= span / 2) {
      probes.push(estimateBpm(slice));
    }
  }
  if (probes.length === 0) {
    return null;
  }
  let min = Infinity;
  let max = -Infinity;
  for (const b of probes) {
    min = Math.min(min, b);
    max = Math.max(max, b);
  }
  if (max - min > MULTI_TEMPO_TOLERANCE_BPM) {
    return null;
  }
  const sorted = [...probes].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return Number(median.toFixed(2));
}

/**
 * Snap a peak hop to a LOCAL downbeat: estimate tempo+phase in a ±8s window around
 * the peak and snap to the nearest grid beat. A single global grid drifts ~8 beats
 * by the end of a 48-min multi-tempo set, so the snap is always local. Returns
 * { anchorMs, barMs }; barMs is the local bar length (for the pre-roll).
 */
function snapToLocalDownbeat(
  flux: Float32Array,
  peakHop: number,
): { anchorMs: number; barMs: number } {
  const half = Math.round(LOCAL_TEMPO_HALF_MS / HOP_MS);
  const lo = Math.max(0, peakHop - half);
  const hi = Math.min(flux.length, peakHop + half);
  const slice = flux.subarray(lo, hi);
  const peakMs = peakHop * HOP_MS;
  if (slice.length < 8) {
    return { anchorMs: peakMs, barMs: BAR_SMOOTH_MS };
  }
  const localBpm = estimateBpm(slice);
  const barMs = (60_000 / localBpm) * 4;
  const grid = bestPhaseGrid(slice, localBpm, slice.length * HOP_MS); // ms within the slice
  const peakInSliceMs = (peakHop - lo) * HOP_MS;
  let nearest = peakInSliceMs;
  let best = Infinity;
  for (const g of grid) {
    const d = Math.abs(g - peakInSliceMs);
    if (d < best) {
      best = d;
      nearest = g;
    }
  }
  return { anchorMs: lo * HOP_MS + nearest, barMs };
}

/**
 * The top-N drop picker. Operates on the internal-hop (20ms) normalized curves.
 *
 * - dropScore[t] = max(0, postBass − preBass) · postBass · (re-entry-flux factor) —
 *   a quiet breakdown then a loud bass slam, on bar-smoothed bass.
 * - LOCAL max-normalization (±30s) so a quieter-but-locally-prominent drop survives
 *   (a global max would pin the scale to the single loudest drop).
 * - Peak-pick the local maxima, greedily de-duped to a ≥~35s inter-peak spacing.
 * - Snap each peak to a LOCAL downbeat, then build a window with a one-bar pre-roll
 *   so the drop lands just inside the clip.
 * - Rank by meanEnergy + 2·meanBass + 0.02·onsetDensity + λ·dropScore; return top N.
 *
 * Pure + deterministic. `energy`/`bass`/`flux` are aligned Float32Arrays at HOP_MS.
 */
export function pickDrops(
  energy: Float32Array,
  bass: Float32Array,
  flux: Float32Array,
  opts: {
    suggestionMs?: number;
    topN?: number;
    minPeakSpacingMs?: number;
  } = {},
): PickResult {
  const suggestionMs = opts.suggestionMs ?? DEFAULT_SUGGESTION_MS;
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const minSpacingMs = opts.minPeakSpacingMs ?? DEFAULT_MIN_PEAK_SPACING_MS;

  const n = bass.length;
  const totalMs = n * HOP_MS;
  const bpm = estimateGlobalBpm(flux);

  if (n < 4) {
    return { bpm, peaks: [], suggestions: [] };
  }

  // Bar-scale smoothed bass + a peak flux scale for the re-entry factor.
  const barHalf = Math.max(1, Math.round(BAR_SMOOTH_MS / 2 / HOP_MS));
  const smoothBass = movingAverage(bass, barHalf);
  let fluxMax = 0;
  for (let i = 0; i < flux.length; i++) {
    if (flux[i] > fluxMax) {
      fluxMax = flux[i];
    }
  }
  const fluxScale = fluxMax > 0 ? fluxMax : 1;

  const preHops = Math.round(NOVELTY_PRE_MS / HOP_MS);
  const postHops = Math.round(NOVELTY_POST_MS / HOP_MS);
  const fluxHops = Math.round(REENTRY_FLUX_MS / HOP_MS);

  // Drop-novelty: breakdown (pre) → slam (post), weighted by the re-entry transient.
  const dropScore = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    const pre = meanRange(smoothBass, t - preHops, t - 1);
    const post = meanRange(smoothBass, t, t + postHops);
    const rise = Math.max(0, post - pre);
    const reentry = meanRange(flux, t, t + fluxHops) / fluxScale;
    dropScore[t] = rise * post * (0.25 + 0.75 * Math.min(1, reentry));
  }

  // LOCAL max-normalization — NOT global (a global max buries quieter good drops).
  const localHalf = Math.max(1, Math.round(LOCAL_NORM_HALF_MS / HOP_MS));
  const localMax = slidingMax(dropScore, localHalf);
  const dropNorm = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    dropNorm[t] = localMax[t] > 1e-9 ? dropScore[t] / localMax[t] : 0;
  }

  // Local maxima of the normalized novelty, above a floor, away from the edges.
  const neighHops = Math.max(1, Math.round(1_000 / HOP_MS)); // ±1s non-max suppression
  const candidates: { hop: number; norm: number; raw: number }[] = [];
  for (let t = 1; t < n - 1; t++) {
    if (dropNorm[t] < 0.5 || dropScore[t] <= 1e-9) {
      continue;
    }
    let isMax = true;
    for (let j = Math.max(0, t - neighHops); j <= Math.min(n - 1, t + neighHops); j++) {
      if (dropNorm[j] > dropNorm[t]) {
        isMax = false;
        break;
      }
    }
    if (isMax) {
      candidates.push({ hop: t, norm: dropNorm[t], raw: dropScore[t] });
    }
  }

  // Greedy peak-pick with a minimum inter-peak spacing (favor locally-prominent).
  candidates.sort((a, b) => b.norm - a.norm || b.raw - a.raw);
  const minSpacingHops = Math.round(minSpacingMs / HOP_MS);
  const accepted: { hop: number; norm: number }[] = [];
  for (const c of candidates) {
    if (accepted.every((a) => Math.abs(a.hop - c.hop) >= minSpacingHops)) {
      accepted.push({ hop: c.hop, norm: c.norm });
    }
  }

  // Onset times (ms) for the per-window onset density (reuses the render kernel).
  const onsets = pickOnsets(flux);

  const built = accepted.map(({ hop, norm }) => {
    const { anchorMs, barMs } = snapToLocalDownbeat(flux, hop);
    // One-bar pre-roll so the drop lands just inside the clip (clamped to the set).
    const preRollMs = Math.min(barMs, suggestionMs * 0.4);
    let startMs = Math.round(anchorMs - preRollMs);
    startMs = Math.max(0, Math.min(startMs, Math.max(0, totalMs - suggestionMs)));
    const durationMs = Math.min(suggestionMs, totalMs - startMs);

    const startHop = Math.round(startMs / HOP_MS);
    const endHop = Math.min(n, startHop + Math.round(durationMs / HOP_MS));
    let eSum = 0;
    let bSum = 0;
    const span = Math.max(1, endHop - startHop);
    for (let h = startHop; h < endHop; h++) {
      eSum += energy[h];
      bSum += bass[h];
    }
    const endMs = startMs + durationMs;
    const onsetCount = onsets.filter((o) => o >= startMs && o < endMs).length;
    const meanEnergy = eSum / span;
    const meanBass = bSum / span;
    const onsetDensity = onsetCount / (durationMs / 1000);
    const score = meanEnergy + 2 * meanBass + 0.02 * onsetDensity + DROP_SCORE_WEIGHT * norm;

    return { anchorMs: Math.round(anchorMs), durationMs, score, startMs };
  });

  // Rank, take top N, re-dedupe spacing (anchors should already be spaced).
  built.sort((a, b) => b.score - a.score);
  const suggestions: StudioSuggestion[] = [];
  for (const s of built) {
    if (suggestions.length >= topN) {
      break;
    }
    if (suggestions.every((x) => Math.abs(x.anchorMs - s.anchorMs) >= minSpacingMs)) {
      suggestions.push({
        anchorMs: s.anchorMs,
        durationMs: s.durationMs,
        score: Number(s.score.toFixed(4)),
        startMs: s.startMs,
      });
    }
  }

  const peaks: StudioPeak[] = suggestions
    .map((s) => ({ atMs: s.anchorMs, kind: "drop" as const, score: s.score }))
    .sort((a, b) => a.atMs - b.atMs);

  return { bpm, peaks, suggestions };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Decode a set audio file and produce its `StudioEnvelope`. */
export async function analyzeSet(
  setPath: string,
  opts: AnalyzeSetOptions = {},
): Promise<StudioEnvelope> {
  const sampleRate = opts.sampleRate ?? SET_SAMPLE_RATE;
  const displayHopMs = opts.displayHopMs ?? DISPLAY_HOP_MS;

  const samples = await decodeSetMono(setPath, sampleRate);
  const bands: Bands = computeBands({ sampleRate, samples });
  const fluxRaw = onsetEnvelope(bands);

  // Normalize like the render path (energy self-referenced; bands shared-reference),
  // then run the picker on the same normalized curves.
  const energyHop = new Float32Array(bands.full);
  const bassHop = new Float32Array(bands.bass);
  const midHop = new Float32Array(bands.mid);
  const trebleHop = new Float32Array(bands.high);
  normalizeInPlace(energyHop);
  normalizeBandsShared([bassHop, midHop, trebleHop]);
  const fluxHop = new Float32Array(fluxRaw);
  normalizeInPlace(fluxHop);

  const { bpm, peaks, suggestions } = pickDrops(energyHop, bassHop, fluxHop, {
    minPeakSpacingMs: opts.minPeakSpacingMs,
    suggestionMs: opts.suggestionMs,
    topN: opts.topN,
  });

  const durationMs = bands.hopCount * HOP_MS;
  const factor = Math.max(1, Math.round(displayHopMs / HOP_MS));

  return {
    bass: decimate(bassHop, factor),
    bpm,
    durationMs,
    energy: decimate(energyHop, factor),
    flux: decimate(fluxHop, factor),
    hopMs: factor * HOP_MS,
    peaks,
    suggestions,
  };
}

/** Produce a `StudioEnvelope` and write it as JSON to `outPath`. */
export async function writeStudioEnvelope(
  setPath: string,
  outPath: string,
  opts: AnalyzeSetOptions = {},
): Promise<StudioEnvelope> {
  const envelope = await analyzeSet(setPath, opts);
  await writeFile(outPath, JSON.stringify(envelope));
  return envelope;
}

// Run directly: `bun src/pipeline/analyze-set.ts <set.(m4a|wav|mp4)> [out.json]`.
if (import.meta.main) {
  const [, , setPath, outPath] = process.argv;
  if (!setPath) {
    console.error("usage: analyze-set <set-audio> [out.json]");
    process.exit(1);
  }
  const target = outPath ?? `${setPath}.studio-envelope.json`;
  const env = await writeStudioEnvelope(setPath, target);
  console.log(
    `✓ analyze-set: ${(env.durationMs / 60000).toFixed(1)}min, bpm=${env.bpm ?? "null (multi-tempo)"}, ${env.suggestions.length} candidate drops → ${target}`,
  );
}
