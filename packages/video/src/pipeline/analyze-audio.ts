// Offline audio analysis for the "NostalgicCosmos" composition.
//
// Reads a mono PCM wav, derives RMS energy at 20ms hops, splits into bands via
// a Hann-windowed STFT (the classic bass/mid/treble plus the fine sub/kick/
// snare/air split, each band its PEAK bin so transient punch survives — not
// averaged away), builds a superflux onset envelope, estimates BPM honestly via
// autocorrelation + harmonic-comb verification (the D&B half-time octave is
// doubled ONLY when the comb supports it — never hard-clamped), lays a
// best-phase beat grid + bar downbeats, picks the best contiguous 20s window,
// detects the drop inside it (breakdown→slam novelty), and trims everything
// relative to that window's start — normalizing the curves WITHIN the window so
// the clip's own peak reads 1.0.

import { readFile } from "node:fs/promises";

import { type CosmosAudio, type EnergySample } from "../remotion/types";
import {
  type DecodedWav,
  HOP_MS,
  computeBands,
  emphasizeTransients,
  meanRange,
  movingAverage,
  normalizeBandsShared,
  normalizeInPlace,
  onsetEnvelope,
  percentile,
} from "./audio-curves";

// The per-hop curve-builders (computeBands / onsetEnvelope / the normalizers /
// percentile) live in audio-curves.ts so the set path (analyze-set.ts) shares the
// exact same kernel. Re-exported here so existing importers (analyze-audio.test.ts,
// fft.test.ts) keep their import sites unchanged.
export {
  type Bands,
  type DecodedWav,
  computeBands,
  normalizeBandsShared,
  onsetEnvelope,
  percentile,
} from "./audio-curves";

const TARGET_WINDOW_MS = 20000;
// The honest tempo search span. NOT a clamp: the estimate may land anywhere in
// it. The old [160,185] hard fold is gone — it pinned out-of-family tempos to
// exactly 160/185, fabricating grids that put every beat pulse off-beat.
const BPM_SEARCH_MIN = 60;
const BPM_SEARCH_MAX = 200;
// The D&B half-time reading: a raw estimate in this span MAY be an octave-down
// detection of a 140-200 tempo. It is doubled ONLY when the harmonic comb
// supports it (real onset energy at the half period); a genuine 87 BPM signal
// with nothing at the half period stays 87.
const HALF_TIME_MIN = 70;
const HALF_TIME_MAX = 100;

/** Minimal PCM WAV (s16le or f32) reader. Returns mono float samples. */
function decodeWav(buf: Buffer): DecodedWav {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("analyzeAudio: not a RIFF/WAVE file");
  }

  let offset = 12;
  let sampleRate = 22050;
  let bitsPerSample = 16;
  let numChannels = 1;
  let audioFormat = 1;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === "fmt ") {
      audioFormat = buf.readUInt16LE(body);
      numChannels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (chunkId === "data") {
      dataOffset = body;
      dataLength = chunkSize;
    }
    offset = body + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0) {
    throw new Error("analyzeAudio: no data chunk in wav");
  }

  const frameCount = Math.floor(dataLength / ((bitsPerSample / 8) * numChannels));
  const samples = new Float32Array(frameCount);

  for (let i = 0; i < frameCount; i++) {
    let acc = 0;
    for (let c = 0; c < numChannels; c++) {
      const bytePos = dataOffset + (i * numChannels + c) * (bitsPerSample / 8);
      if (audioFormat === 3 && bitsPerSample === 32) {
        acc += buf.readFloatLE(bytePos);
      } else if (bitsPerSample === 16) {
        acc += buf.readInt16LE(bytePos) / 32768;
      } else if (bitsPerSample === 8) {
        acc += (buf.readUInt8(bytePos) - 128) / 128;
      } else if (bitsPerSample === 24) {
        const b0 = buf.readUInt8(bytePos);
        const b1 = buf.readUInt8(bytePos + 1);
        const b2 = buf.readUInt8(bytePos + 2);
        let v = b0 | (b1 << 8) | (b2 << 16);
        if (v & 0x800000) {
          v -= 0x1000000;
        }
        acc += v / 8388608;
      }
    }
    samples[i] = acc / numChannels;
  }

  return { sampleRate, samples };
}

/**
 * Raw crest factor of a band = P98 / mean (a flat 1e-9 floor on the mean guards
 * a silent band). High on a dynamic band, ~1 on a steady one. Run on the RAW
 * pre-normalization band so it reflects the track's true dynamics.
 */
function crestFactor(band: Float32Array): number {
  if (band.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < band.length; i++) {
    sum += band[i];
  }
  const mean = sum / band.length;
  return percentile(band, 0.98) / Math.max(mean, 1e-9);
}

export type BpmEstimate = {
  /** Honest best tempo estimate — UNCLAMPED, may legitimately sit outside [160,185]. */
  bpm: number;
  /** 0..1: autocorrelation peak prominence + harmonic-comb agreement. */
  confidence: number;
};

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * Honest autocorrelation BPM with harmonic-comb verification. Exported for tests.
 *
 * 1. Mean-removed autocorrelation over the full [60,200] BPM lag span,
 *    normalized by the zero-lag energy so values are comparable across signals.
 * 2. Each candidate lag L is scored by a harmonic COMB — r(L) + ½r(2L) + ⅓r(3L)
 *    — so the true beat period (whose multiples all correlate) beats a spurious
 *    single-lag peak. A gentle 1/L^0.15 preference breaks the impulse-train tie
 *    between a period and its double toward the faster tempo.
 * 3. Parabolic sub-hop refinement of the winning lag (20ms hops are ~10 BPM
 *    apart near 174; the vertex offset tightens to the true tempo).
 * 4. The D&B octave fold happens ONLY when the comb supports it: a raw estimate
 *    in [70,100] doubles iff there is real correlation at the HALF period
 *    (r(L/2) ≥ 0.4·r(L)) — the half-time drum pattern whose hats/snare still
 *    tick at the doubled rate. A genuine 87 BPM signal stays 87; a genuine
 *    128 BPM signal stays 128 — never pinned to 160/185.
 *
 * Pure + deterministic.
 */
export function estimateBpmDetailed(env: Float32Array): BpmEstimate {
  // Mean-remove the envelope for a cleaner autocorrelation.
  let mean = 0;
  for (let i = 0; i < env.length; i++) {
    mean += env[i];
  }
  mean /= Math.max(1, env.length);
  const centered = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) {
    centered[i] = env[i] - mean;
  }

  const bpmToLag = (bpm: number): number => (60 / bpm) * (1000 / HOP_MS);
  const lagToBpm = (lag: number): number => (60 * (1000 / HOP_MS)) / lag;

  const lagMin = Math.max(1, Math.floor(bpmToLag(BPM_SEARCH_MAX)));
  const lagMax = Math.ceil(bpmToLag(BPM_SEARCH_MIN));

  // Cache the raw autocorrelation per lag; normalize by zero-lag energy.
  const corr = new Map<number, number>();
  const autocorr = (lag: number): number => {
    const cached = corr.get(lag);
    if (cached !== undefined) {
      return cached;
    }
    let acc = 0;
    for (let i = lag; i < centered.length; i++) {
      acc += centered[i] * centered[i - lag];
    }
    corr.set(lag, acc);
    return acc;
  };
  const r0 = autocorr(0);
  if (r0 <= 1e-12 || env.length <= lagMin + 1) {
    // Silent/degenerate envelope: no tempo evidence at all.
    return { bpm: lagToBpm(Math.max(1, lagMin)), confidence: 0 };
  }
  // Normalized autocorrelation, floored at 0 (anti-correlation is "no support").
  const nr = (lag: number): number =>
    lag >= centered.length || lag < 0 ? 0 : Math.max(0, autocorr(lag) / r0);
  // FRACTIONAL-lag read: a true beat period rarely sits on the 20ms lag grid
  // (174 BPM = 17.24 hops), so a harmonic/sub-lag is read as the max of its two
  // neighbouring integer lags — the quantization guard.
  const nrAt = (lag: number): number => Math.max(nr(Math.floor(lag)), nr(Math.ceil(lag)));
  const comb = (lag: number): number => nr(lag) + 0.5 * nrAt(2 * lag) + (1 / 3) * nrAt(3 * lag);

  let bestLag = lagMin;
  let bestScore = -Infinity;
  for (let lag = lagMin; lag <= lagMax && lag < centered.length; lag++) {
    const score = comb(lag) / lag ** 0.15;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  // FUNDAMENTAL RESOLUTION: the comb winner is often a period MULTIPLE of the
  // true beat — on a quantized lag grid a larger multiple aligns better with
  // integer lags (a 128 BPM train's 2-beat lag 46.9 rounds cleaner than its
  // 23.4 beat lag), and a dotted rhythm puts a strong peak at 1.5 beats (a real
  // 174 D&B preview read 116 without the 3/2 divisor). So resolve down: the
  // largest divisor whose sub-lag still carries real correlation is the true
  // beat period.
  let bestDiv = 1;
  for (const d of [1.5, 2, 3, 4]) {
    const subLag = bestLag / d;
    if (subLag < 2 || lagToBpm(subLag) > BPM_SEARCH_MAX) {
      continue;
    }
    if (nrAt(subLag) >= 0.4 * nr(bestLag) && nrAt(subLag) > 0.05) {
      bestDiv = d;
    }
  }
  const resolvedLag = bestLag / bestDiv;
  // The better-aligned integer lag around the (possibly fractional) resolution.
  const lo = Math.max(1, Math.floor(resolvedLag));
  const hi = Math.ceil(resolvedLag);
  const intLag = nr(hi) > nr(lo) ? hi : lo;

  // Parabolic (quadratic) interpolation of the autocorrelation peak: fit a parabola
  // through r[k-1], r[k], r[k+1] and shift the lag by its vertex offset. At 20ms
  // hops the integer-lag grid is ~10 BPM apart near 174; the sub-hop refinement
  // tightens it the rest of the way to the true tempo.
  const parabolic = (k: number): number => {
    if (k - 1 < 1 || k + 1 >= centered.length) {
      return k;
    }
    const rPrev = autocorr(k - 1);
    const rPeak = autocorr(k);
    const rNext = autocorr(k + 1);
    const denom = rPrev - 2 * rPeak + rNext;
    if (Math.abs(denom) <= 1e-9) {
      return k;
    }
    const offset = Math.max(-0.5, Math.min(0.5, (0.5 * (rPrev - rNext)) / denom));
    return k + offset;
  };
  let refinedLag = parabolic(intLag);

  // LONG-LAG ANCHOR: re-read the period from the highest supported MULTIPLE (up
  // to 8 beats) — the quantization + interpolation error divides by the
  // multiple, so a ~0.8% single-lag error (175.4 for a true 174, ~200ms of grid
  // drift over 20s) tightens to ~0.1%. Each multiple must carry real
  // correlation; the search re-centres ±2 lags so small tempo error at 8× still
  // finds the true peak.
  for (const m of [2, 4, 8]) {
    const target = refinedLag * m;
    const centre = Math.round(target);
    if (centre + 3 >= centered.length) {
      break;
    }
    let anchorInt = centre;
    let anchorVal = -Infinity;
    for (let l = centre - 2; l <= centre + 2; l++) {
      if (l >= 2 && autocorr(l) > anchorVal) {
        anchorVal = autocorr(l);
        anchorInt = l;
      }
    }
    if (nr(anchorInt) < 0.2 * nr(intLag)) {
      continue;
    }
    refinedLag = parabolic(anchorInt) / m;
  }

  let bpm = lagToBpm(refinedLag);
  let folded = false;
  if (bpm >= HALF_TIME_MIN && bpm <= HALF_TIME_MAX) {
    // The comb-supported D&B octave fold (see the function doc).
    const halfLag = refinedLag / 2;
    if (halfLag >= 1 && nrAt(halfLag) >= 0.4 * nr(intLag) && nrAt(halfLag) > 0.05) {
      bpm *= 2;
      folded = true;
    }
  }

  // Confidence: peak prominence (normalized autocorr at the detected period) +
  // comb agreement (its harmonics, and the half period when folded).
  const peak = clamp01(nr(intLag));
  const harmonics = folded
    ? (clamp01(nrAt(refinedLag / 2)) + clamp01(nrAt(2 * refinedLag))) / 2
    : (clamp01(nrAt(2 * refinedLag)) + clamp01(nrAt(3 * refinedLag))) / 2;
  const confidence = clamp01(0.55 * peak + 0.45 * harmonics);

  return { bpm, confidence: Number(confidence.toFixed(3)) };
}

/**
 * Compat wrapper: the honest (UNCLAMPED) tempo as a bare number. The set path
 * (analyze-set.ts) probes local tempo with this; honest per-probe octaves mean a
 * genuinely mixed set now reads multi-tempo (bpm null → the per-peak local snap),
 * instead of every probe being folded into [160,185].
 */
export function estimateBpm(env: Float32Array): number {
  return estimateBpmDetailed(env).bpm;
}

/**
 * Best-phase beat grid: choose the phase offset maximizing onset energy on
 * beats. Exported for tests. Each candidate phase is accumulated by stepping
 * the TRUE fractional beat period in ms (previously the step was rounded to
 * whole hops, which aliased against fractional beat lags — 174 BPM is 17.24
 * hops — and smeared the phase scoring into near-noise on long envelopes).
 */
export function bestPhaseGrid(env: Float32Array, bpm: number, totalMs: number): number[] {
  const beatMs = 60000 / bpm;
  const phaseSteps = Math.max(1, Math.round(beatMs / HOP_MS));

  let bestPhase = 0;
  let bestScore = -Infinity;
  for (let p = 0; p < phaseSteps; p++) {
    let acc = 0;
    for (let t = p * HOP_MS; t < totalMs; t += beatMs) {
      acc += env[Math.round(t / HOP_MS)] ?? 0;
    }
    if (acc > bestScore) {
      bestScore = acc;
      bestPhase = p;
    }
  }

  const grid: number[] = [];
  const phaseMs = bestPhase * HOP_MS;
  for (let t = phaseMs; t < totalMs; t += beatMs) {
    grid.push(Math.round(t));
  }
  return grid;
}

// The adaptive picker's locality: the median window is ~±750ms (long enough to
// span a bar of context, short enough that a loud drop can't raise the floor
// under a quiet intro), sampled on an 8-hop stride and lerped between samples.
const ONSET_MEDIAN_HALF_MS = 750;
const ONSET_MEDIAN_STRIDE_HOPS = 8;
// The margin above the local median, as a fraction of the envelope's robust
// (P95) global scale — scale-aware so the picker works on raw AND normalized
// envelopes.
const ONSET_DELTA_FRACTION = 0.15;

/** Median of arr[lo..hi) via a sorted copy (small windows only). */
function medianRange(arr: Float32Array, lo: number, hi: number): number {
  const from = Math.max(0, lo);
  const to = Math.min(arr.length, hi);
  if (to <= from) {
    return 0;
  }
  const slice = Float32Array.from(arr.subarray(from, to)).sort();
  return slice[slice.length >> 1] ?? 0;
}

/**
 * Pick onset peaks from an onset-strength envelope as ms timestamps. Exported
 * for tests; the render path feeds it the SUPERFLUX envelope (log-compressed
 * per-bin flux with a cross-bin maximum-filter — see computeBands), the set
 * path its 3-band flux curve.
 *
 * The threshold is an adaptive LOCAL median (±750ms) plus a robust-scale
 * margin, replacing the old global mean+0.6σ: a global threshold sat above
 * every quiet-intro transient the moment the track had a loud drop, so the
 * intro read as onset-free. The local median follows the section's own floor,
 * so quiet-section transients survive loud sections. Local maxima only, with
 * an 80ms refractory gap. Pure + deterministic.
 */
export function pickOnsets(env: Float32Array): number[] {
  const n = env.length;
  if (n < 3) {
    return [];
  }

  const delta = ONSET_DELTA_FRACTION * percentile(env, 0.95);
  const halfHops = Math.max(1, Math.round(ONSET_MEDIAN_HALF_MS / HOP_MS));

  // Strided local medians, linearly interpolated to every hop (O(n·w/stride)).
  const stride = ONSET_MEDIAN_STRIDE_HOPS;
  const centers: number[] = [];
  for (let c = 0; c < n; c += stride) {
    centers.push(medianRange(env, c - halfHops, c + halfHops + 1));
  }
  const medianAt = (h: number): number => {
    const pos = h / stride;
    const i0 = Math.min(centers.length - 1, Math.floor(pos));
    const i1 = Math.min(centers.length - 1, i0 + 1);
    const t = pos - i0;
    return centers[i0] + (centers[i1] - centers[i0]) * t;
  };

  const onsets: number[] = [];
  const minGapHops = Math.max(1, Math.round(80 / HOP_MS)); // 80ms refractory
  let lastHop = -minGapHops;
  for (let h = 1; h < n - 1; h++) {
    if (
      env[h] > medianAt(h) + delta &&
      env[h] >= env[h - 1] &&
      env[h] >= env[h + 1] &&
      h - lastHop >= minGapHops
    ) {
      onsets.push(h * HOP_MS);
      lastHop = h;
    }
  }
  return onsets;
}

/**
 * Bar-phase estimation: given the beat grid (ms) and a per-hop KICK/BASS onset
 * strength, score the 4 candidate phase-groupings (bars start on beat p, p+4,
 * p+8, …) by the mean strength landing on their beats, and return every 4th
 * beat of the winner — the downbeats. D&B accents the bar head (the kick on
 * the one), so the phase whose beats carry the most low-end attack is the bar
 * line. Exported for tests. Pure + deterministic.
 */
export function pickDownbeats(gridMs: number[], strength: Float32Array): number[] {
  if (gridMs.length < 4) {
    return [];
  }
  let bestPhase = 0;
  let bestScore = -Infinity;
  for (let p = 0; p < 4; p++) {
    let acc = 0;
    let count = 0;
    for (let i = p; i < gridMs.length; i += 4) {
      const h = Math.round(gridMs[i] / HOP_MS);
      // Max over ±1 hop absorbs grid/hop rounding.
      acc += Math.max(strength[h - 1] ?? 0, strength[h] ?? 0, strength[h + 1] ?? 0);
      count++;
    }
    const score = acc / Math.max(1, count);
    if (score > bestScore) {
      bestScore = score;
      bestPhase = p;
    }
  }
  const downbeats: number[] = [];
  for (let i = bestPhase; i < gridMs.length; i += 4) {
    downbeats.push(gridMs[i]);
  }
  return downbeats;
}

/** A scored drop candidate inside the clip window (ms relative to clip start). */
export type DropCandidate = { timeMs: number; score: number };

// The clip drop picker's shape parameters — the analyze-set.ts drop-novelty
// kernel scaled to a ≤30s window. Pre/post are ~2 bars at 174 so a
// breakdown→slam reads cleanly; spacing keeps candidates a bar-pair apart.
const DROP_NOVELTY_PRE_MS = 3_000;
const DROP_NOVELTY_POST_MS = 3_000;
const DROP_REENTRY_FLUX_MS = 800;
const DROP_BAR_SMOOTH_MS = 1_400;
const DROP_MIN_SPACING_MS = 2_000;
const DROP_MAX_CANDIDATES = 5;
// A drop needs room to PLAY OUT: the default envelope is ~1.9s of rise+hold+
// fall, so a candidate in the clip's final 2s would put the climax on the
// literal last frames (seen on a real track whose next section slams in right
// as the window ends). Such tail candidates are excluded outright — better no
// dropMs (the loudest-sample fallback) than a climax the clip cannot finish.
const DROP_TAIL_GUARD_MS = 2_000;

/**
 * The drop picker for the render path's clip window — the analyze-set.ts
 * drop-novelty approach (quiet breakdown → loud slam contrast on bar-smoothed
 * bass, weighted by the re-entry transient flux, peak-picked with non-max
 * suppression and spacing dedupe) applied to the window's own curves. On a
 * ≤30s window the set path's ±30s LOCAL max-normalization degenerates to the
 * window max, so scores are normalized 0..1 by the window's strongest novelty.
 *
 * `bass`/`flux` are the WINDOW-relative normalized curves at HOP_MS; returned
 * times are ms relative to clip start, score-descending. Exported for tests.
 * Pure + deterministic.
 */
export function pickClipDrops(bass: Float32Array, flux: Float32Array): DropCandidate[] {
  const n = bass.length;
  if (n < 8) {
    return [];
  }

  const barHalf = Math.max(1, Math.round(DROP_BAR_SMOOTH_MS / 2 / HOP_MS));
  const smoothBass = movingAverage(bass, barHalf);
  let fluxMax = 0;
  for (let i = 0; i < flux.length; i++) {
    if (flux[i] > fluxMax) {
      fluxMax = flux[i];
    }
  }
  const fluxScale = fluxMax > 0 ? fluxMax : 1;

  const preHops = Math.round(DROP_NOVELTY_PRE_MS / HOP_MS);
  const postHops = Math.round(DROP_NOVELTY_POST_MS / HOP_MS);
  const fluxHops = Math.round(DROP_REENTRY_FLUX_MS / HOP_MS);

  // Drop-novelty: breakdown (pre) → slam (post), weighted by the re-entry transient.
  const dropScore = new Float32Array(n);
  let scoreMax = 0;
  for (let t = 0; t < n; t++) {
    const pre = meanRange(smoothBass, t - preHops, t - 1);
    const post = meanRange(smoothBass, t, t + postHops);
    const rise = Math.max(0, post - pre);
    const reentry = meanRange(flux, t, t + fluxHops) / fluxScale;
    dropScore[t] = rise * post * (0.25 + 0.75 * Math.min(1, reentry));
    if (dropScore[t] > scoreMax) {
      scoreMax = dropScore[t];
    }
  }
  if (scoreMax <= 1e-9) {
    return [];
  }

  // Local maxima of the normalized novelty, above a floor, ±1s non-max
  // suppression, and never inside the tail guard (see DROP_TAIL_GUARD_MS).
  const neighHops = Math.max(1, Math.round(1_000 / HOP_MS));
  const lastHop = n - 1 - Math.round(DROP_TAIL_GUARD_MS / HOP_MS);
  const candidates: { hop: number; norm: number }[] = [];
  for (let t = 1; t <= lastHop; t++) {
    const norm = dropScore[t] / scoreMax;
    if (norm < 0.5) {
      continue;
    }
    let isMax = true;
    for (let j = Math.max(0, t - neighHops); j <= Math.min(n - 1, t + neighHops); j++) {
      if (dropScore[j] > dropScore[t]) {
        isMax = false;
        break;
      }
    }
    if (isMax) {
      candidates.push({ hop: t, norm });
    }
  }

  // Greedy spacing dedupe, strongest first, capped.
  candidates.sort((a, b) => b.norm - a.norm || a.hop - b.hop);
  const minSpacingHops = Math.round(DROP_MIN_SPACING_MS / HOP_MS);
  const accepted: DropCandidate[] = [];
  for (const c of candidates) {
    if (accepted.length >= DROP_MAX_CANDIDATES) {
      break;
    }
    if (accepted.every((a) => Math.abs(Math.round(a.timeMs / HOP_MS) - c.hop) >= minSpacingHops)) {
      accepted.push({ score: Number(c.norm.toFixed(4)), timeMs: c.hop * HOP_MS });
    }
  }
  return accepted;
}

/**
 * Analyze a mono PCM wav into the CosmosAudio contract. `file` is the staticFile
 * filename; the caller supplies it (the analysis wav itself is not shipped).
 */
// targetMs is the desired clip length (default 20s); the agent may shorten it
// based on the waveform so the clip ends on a drop or just before a transition.
export async function analyzeAudio(
  wavPath: string,
  file: string,
  targetMs: number = TARGET_WINDOW_MS,
): Promise<CosmosAudio> {
  const clampedTargetMs = Math.max(10_000, Math.min(30_000, targetMs));
  const buf = await readFile(wavPath);
  const decoded = decodeWav(buf);

  const bands = computeBands(decoded);
  const env = onsetEnvelope(bands);

  const totalMs = bands.hopCount * HOP_MS;

  // Per-band RAW crest factor (P98 / mean), computed BEFORE normalization while
  // the bands still carry their true dynamics. A dynamic track reads a high crest;
  // a flat one reads low. Shipped as `rawDynamicsHint` so the motion checker can
  // tell a genuinely flat track from one the normalizer flattened (the A↔C contract).
  const rawDynamicsHint = {
    bass: Number(crestFactor(bands.bass).toFixed(4)),
    mid: Number(crestFactor(bands.mid).toFixed(4)),
    treble: Number(crestFactor(bands.high).toFixed(4)),
  };

  // Full-preview-normalized energy + bass copies for WINDOW SELECTION only. The
  // OUTPUT curves are normalized within the chosen window further down, so the
  // clip's own peak reads 1.0 (u_energy actually reaches the top of its range).
  const energyFull = new Float32Array(bands.full);
  const bassFull = new Float32Array(bands.bass);
  const midFull = new Float32Array(bands.mid);
  const trebleFull = new Float32Array(bands.high);
  normalizeInPlace(energyFull);
  normalizeBandsShared([bassFull, midFull, trebleFull]);

  // Tempo, grid, and onsets are driven by the SUPERFLUX envelope (log-compressed
  // per-bin flux, cross-bin max-filtered — see computeBands): loudness-robust, so
  // the estimate hears the whole preview, not just its loudest section.
  const { bpm, confidence: bpmConfidence } = estimateBpmDetailed(bands.superflux);
  const superfluxNorm = new Float32Array(bands.superflux);
  normalizeInPlace(superfluxNorm);

  // Window selection: best contiguous window scored by mean energy + 2*bass + onset density.
  const windowMs = Math.min(clampedTargetMs, totalMs);
  const windowHops = Math.max(1, Math.round(windowMs / HOP_MS));

  const onsetsAll = pickOnsets(bands.superflux);

  let bestStartHop = 0;
  let bestScore = -Infinity;
  const lastStart = Math.max(0, bands.hopCount - windowHops);
  for (let s = 0; s <= lastStart; s++) {
    let energySum = 0;
    let bassSum = 0;
    for (let h = s; h < s + windowHops; h++) {
      energySum += energyFull[h] ?? 0;
      bassSum += bassFull[h] ?? 0;
    }
    const startMs = s * HOP_MS;
    const endMs = (s + windowHops) * HOP_MS;
    const onsetCount = onsetsAll.filter((o) => o >= startMs && o < endMs).length;
    const meanEnergy = energySum / windowHops;
    const meanBass = bassSum / windowHops;
    const onsetDensity = onsetCount / (windowMs / 1000);
    const score = meanEnergy + 2 * meanBass + 0.02 * onsetDensity;
    if (score > bestScore) {
      bestScore = score;
      bestStartHop = s;
    }
  }

  // Nudge ~400ms earlier than the strongest rise inside the window so the drop
  // lands just after the clip begins.
  let strongestRiseHop = bestStartHop;
  let strongestRise = -Infinity;
  for (let h = bestStartHop + 1; h < bestStartHop + windowHops && h < env.length; h++) {
    const rise = env[h] - env[h - 1];
    if (rise > strongestRise) {
      strongestRise = rise;
      strongestRiseHop = h;
    }
  }
  let startMs = strongestRiseHop * HOP_MS - 400;
  startMs = Math.max(0, Math.min(startMs, totalMs - windowMs));
  startMs = Math.round(startMs);

  const durationMs = Math.min(clampedTargetMs, totalMs - startMs);
  const endMs = startMs + durationMs;

  const startHop = Math.round(startMs / HOP_MS);
  const endHop = Math.min(bands.hopCount, Math.round(endMs / HOP_MS));

  // WINDOW normalization: slice the RAW per-hop arrays to the chosen window and
  // normalize within it (previously curves were normalized over the FULL preview
  // then trimmed, so a clip cut from anywhere but the preview's own global peak
  // never reached 1.0 — u_energy under-read and the docs' "0..1" lied). The
  // clip's own peak now reads 1.0 by construction. Deliberate trade-off: a flat
  // window is lifted to full range too — the shipped `rawDynamicsHint` (raw
  // crest, computed above) is exactly the signal that tells that case apart.
  const slice = (arr: Float32Array): Float32Array => arr.subarray(startHop, endHop);
  const energyWin = new Float32Array(slice(bands.full));
  const bassWin = new Float32Array(slice(bands.bass));
  const midWin = new Float32Array(slice(bands.mid));
  const trebleWin = new Float32Array(slice(bands.high));
  const fluxWin = new Float32Array(slice(env));
  normalizeInPlace(energyWin); // energy stays self-referenced (headline gesture, reaches 1.0)
  normalizeBandsShared([bassWin, midWin, trebleWin]); // ONE shared P97 reference + pow(0.7) lift
  normalizeInPlace(fluxWin); // flux delta envelope keeps its own scale

  // Fine bands: sub (<60Hz weight), kick (60-150Hz) + snare (2-5kHz) with the
  // attack emphasized BEFORE the slice (true deltas at the window edge), air
  // (>5kHz) — normalized as their own shared group, same discipline as the
  // coarse three, so cross-band loudness survives (the kick reads over the air).
  const kickEmph = emphasizeTransients(bands.kick);
  const snareEmph = emphasizeTransients(bands.snare);
  const subWin = new Float32Array(slice(bands.sub));
  const kickWin = new Float32Array(slice(kickEmph));
  const snareWin = new Float32Array(slice(snareEmph));
  const airWin = new Float32Array(slice(bands.air));
  normalizeBandsShared([subWin, kickWin, snareWin, airWin]);

  // Trim curves to the window, time-relative to startMs.
  const toCurve = (win: Float32Array): EnergySample[] =>
    Array.from(win, (v, i) => ({
      energy: Number(v.toFixed(4)),
      timeMs: (startHop + i) * HOP_MS - startMs,
    }));
  const energyCurve = toCurve(energyWin);
  const bassCurve = toCurve(bassWin);
  const midCurve = toCurve(midWin);
  const trebleCurve = toCurve(trebleWin);
  const fluxCurve = toCurve(fluxWin);
  const subCurve = toCurve(subWin);
  const kickCurve = toCurve(kickWin);
  const snareCurve = toCurve(snareWin);
  const airCurve = toCurve(airWin);

  // Beat grid across full clip, then trimmed/relative to the window.
  const fullGrid = bestPhaseGrid(superfluxNorm, bpm, totalMs);
  const beatGrid = fullGrid.flatMap((t) =>
    t >= startMs && t < endMs ? [Math.round(t - startMs)] : [],
  );

  const onsets = onsetsAll.flatMap((o) =>
    o >= startMs && o < endMs ? [Math.round(o - startMs)] : [],
  );

  // Downbeats: bar phase scored on the KICK/SUB attack (the kick on the one),
  // across the full grid, then trimmed to the window like the beat grid.
  const kickStrength = new Float32Array(bands.hopCount);
  for (let h = 1; h < bands.hopCount; h++) {
    const low = bands.sub[h] + bands.kick[h];
    const lowPrev = bands.sub[h - 1] + bands.kick[h - 1];
    kickStrength[h] = Math.max(0, low - lowPrev);
  }
  const downbeats = pickDownbeats(fullGrid, kickStrength).flatMap((t) =>
    t >= startMs && t < endMs ? [Math.round(t - startMs)] : [],
  );

  // The drop: breakdown→slam novelty on the window's own bass/flux (see
  // pickClipDrops). Absent when the window carries no confident drop.
  const dropCandidates = pickClipDrops(bassWin, fluxWin);
  const dropMs = dropCandidates[0]?.timeMs;

  return {
    airCurve,
    bassCurve,
    beatGrid,
    bpm: Number(bpm.toFixed(2)),
    bpmConfidence,
    ...(dropCandidates.length > 0 ? { dropCandidates, dropMs } : {}),
    downbeats,
    durationMs,
    energyCurve,
    file,
    fluxCurve,
    kickCurve,
    midCurve,
    onsets,
    rawDynamicsHint,
    snareCurve,
    startMs,
    subCurve,
    trebleCurve,
  };
}
