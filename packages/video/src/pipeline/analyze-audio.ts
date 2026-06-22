// Offline audio analysis for the "NostalgicCosmos" composition.
//
// Reads a mono PCM wav, derives RMS energy at 20ms hops, splits into 3 bands via
// a Hann-windowed STFT (bass/mid/treble by bin frequency), shipping each band as
// its PEAK bin (transient punch survives — not averaged away), builds an onset
// envelope, estimates BPM via autocorrelation constrained to 160-185 (half-time
// D&B/trap is doubled), lays a best-phase beat grid, picks the best contiguous
// 20s window, and trims/normalizes everything relative to that window's start.

import { readFile } from "node:fs/promises";

import { type CosmosAudio, type EnergySample } from "../remotion/types";
import { fftInPlace, hannWindow, nextPow2 } from "./fft";

const HOP_MS = 20;
const TARGET_WINDOW_MS = 20000;
const BPM_MIN = 160;
const BPM_MAX = 185;
const BASS_CUTOFF_HZ = 150;
const MID_CUTOFF_HZ = 2000;

type DecodedWav = {
  samples: Float32Array;
  sampleRate: number;
};

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

export type Bands = {
  /** Per-hop overall RMS (time-domain) + per-band magnitude, aligned arrays. */
  full: Float32Array;
  bass: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  hopCount: number;
};

/**
 * Per-hop band magnitudes via STFT. `full` is the time-domain RMS (unchanged, so
 * the energy curve / u_energy / the drop envelope are identical); the bands come
 * from a Hann-windowed FFT split by bin frequency — a clean spectral separation,
 * replacing the old one-pole filters whose 6dB/oct rolloff bled a kick into mid
 * and a snare into bass+treble. Each band ships its PEAK bin power (not the
 * mean-per-bin): the transient that IS the kick survives instead of being
 * averaged across the whole band's bins, and peak-per-band is bin-count-
 * independent by construction — no /binCount scaling needed to keep the three
 * bands comparable. The shortened ~46ms STFT frame (paired with the 20ms hop)
 * keeps inter-frame overlap sane so onsets/BPM stay sharp.
 *
 * Exported for fft.test.ts. Pure + deterministic.
 */
export function computeBands(decoded: DecodedWav): Bands {
  const { samples, sampleRate } = decoded;
  const hopSamples = Math.max(1, Math.round((HOP_MS / 1000) * sampleRate));
  const hopCount = Math.floor(samples.length / hopSamples);

  // STFT frame ~46ms, power of two (1024 at 22050Hz → ~21.5Hz/bin → ~7 bins
  // below the 150Hz bass cutoff; scales with the rate if it ever changes). Band
  // boundaries are Hz-derived (floor(cutoff/binHz)) so they auto-recompute.
  const fftSize = nextPow2(Math.round(sampleRate * 0.046));
  const half = fftSize >> 1;
  const win = hannWindow(fftSize);
  const binHz = sampleRate / fftSize;
  const bassMaxBin = Math.max(1, Math.floor(BASS_CUTOFF_HZ / binHz));
  const midMaxBin = Math.max(bassMaxBin + 1, Math.floor(MID_CUTOFF_HZ / binHz));

  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);

  const full = new Float32Array(hopCount);
  const bass = new Float32Array(hopCount);
  const mid = new Float32Array(hopCount);
  const high = new Float32Array(hopCount);

  for (let h = 0; h < hopCount; h++) {
    const start = h * hopSamples;

    // Overall energy: time-domain RMS over the hop (identical to before).
    let sFull = 0;
    for (let i = 0; i < hopSamples; i++) {
      const x = samples[start + i] ?? 0;
      sFull += x * x;
    }
    full[h] = Math.sqrt(sFull / hopSamples);

    // Bands: Hann-windowed FFT over a frame centred on the hop.
    const frameStart = start + (hopSamples >> 1) - half;
    for (let i = 0; i < fftSize; i++) {
      const s = frameStart + i;
      re[i] = (s >= 0 && s < samples.length ? samples[s] : 0) * win[i];
      im[i] = 0;
    }
    fftInPlace(re, im);

    // Peak bin power per band (transient punch survives; bin-count-independent).
    // Bass spans the FULL <150Hz range (the sub-bass that IS D&B's kick), taking
    // its single hottest bin — never narrowed to a 40-120Hz sub-band.
    let pBass = 0;
    let pMid = 0;
    let pHigh = 0;
    for (let k = 1; k <= half; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      if (k <= bassMaxBin) {
        if (p > pBass) {
          pBass = p;
        }
      } else if (k <= midMaxBin) {
        if (p > pMid) {
          pMid = p;
        }
      } else {
        if (p > pHigh) {
          pHigh = p;
        }
      }
    }
    bass[h] = Math.sqrt(pBass);
    mid[h] = Math.sqrt(pMid);
    high[h] = Math.sqrt(pHigh);
  }

  return { bass, full, high, hopCount, mid };
}

/** Half-wave-rectified summed band-energy delta = onset envelope (per hop). Exported for tests. */
export function onsetEnvelope(bands: Bands): Float32Array {
  const { bass, mid, high, hopCount } = bands;
  const env = new Float32Array(hopCount);
  for (let h = 1; h < hopCount; h++) {
    const dBass = Math.max(0, bass[h] - bass[h - 1]);
    const dMid = Math.max(0, mid[h] - mid[h - 1]);
    const dHigh = Math.max(0, high[h] - high[h - 1]);
    env[h] = dBass + dMid + dHigh;
  }
  return env;
}

function normalizeInPlace(arr: Float32Array): void {
  let max = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > max) {
      max = arr[i];
    }
  }
  if (max <= 0) {
    return;
  }
  for (let i = 0; i < arr.length; i++) {
    arr[i] /= max;
  }
}

/**
 * P-percentile (0..1) of a copy of `values`. Robust to a lone clip/crash outlier
 * the way an absolute max is not. Returns 0 on an empty input. Exported for tests.
 */
export function percentile(values: Float32Array, p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = Float32Array.from(values).sort();
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx] ?? 0;
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

/**
 * Normalize the three bands to ONE shared reference so cross-band loudness
 * survives (the kick reads louder than the hats). The reference is the Nth
 * percentile of the POOLED band magnitudes (default 97th) — robust, so a single
 * clip/crash hop cannot crush the rest toward zero the way divide-by-absolute-max
 * did. A mild perceptual lift (pow gamma, default 0.7 < 1) raises groove detail
 * off the floor without clipping the peaks. Clamped to [0,1]. Mutates in place.
 * Exported for tests.
 */
export function normalizeBandsShared(
  bands: Float32Array[],
  opts: { percentile: number; gamma: number } = { gamma: 0.7, percentile: 0.97 },
): void {
  // Pool all band samples to pick one shared divisor.
  let total = 0;
  for (const b of bands) {
    total += b.length;
  }
  const pool = new Float32Array(total);
  let o = 0;
  for (const b of bands) {
    pool.set(b, o);
    o += b.length;
  }
  const ref = percentile(pool, opts.percentile);
  if (ref <= 0) {
    return;
  }
  for (const b of bands) {
    for (let i = 0; i < b.length; i++) {
      const v = Math.min(1, b[i] / ref);
      b[i] = opts.gamma === 1 ? v : Math.pow(v, opts.gamma);
    }
  }
}

/** Autocorrelation-based BPM, constrained to [160,185] (doubles half-time). Exported for tests. */
export function estimateBpm(env: Float32Array): number {
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

  // Search the full plausible tempo span, then fold into [160,185] by doubling
  // half-time detections. This captures D&B/trap that reads as 80-92.
  const searchMin = 70;
  const searchMax = 190;
  const lagMin = Math.floor(bpmToLag(searchMax));
  const lagMax = Math.ceil(bpmToLag(searchMin));

  // Cache the raw autocorrelation per lag so we can refine the peak sub-hop.
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

  let bestLag = lagMin;
  let bestScore = -Infinity;
  for (let lag = lagMin; lag <= lagMax && lag < centered.length; lag++) {
    // Slight bias toward shorter lags (faster tempi) to avoid octave-down errors.
    const score = autocorr(lag) / lag ** 0.5;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  // Parabolic (quadratic) interpolation of the autocorrelation peak: fit a parabola
  // through r[k-1], r[k], r[k+1] and shift the lag by its vertex offset. At 20ms
  // hops the integer-lag grid is already fine (~10 BPM gaps near 174); the sub-hop
  // refinement tightens it the rest of the way to the true tempo (~174 for D&B).
  let refinedLag = bestLag;
  if (bestLag - 1 >= lagMin && bestLag + 1 < centered.length) {
    const rPrev = autocorr(bestLag - 1);
    const rPeak = autocorr(bestLag);
    const rNext = autocorr(bestLag + 1);
    const denom = rPrev - 2 * rPeak + rNext;
    if (Math.abs(denom) > 1e-9) {
      let offset = (0.5 * (rPrev - rNext)) / denom;
      offset = Math.max(-0.5, Math.min(0.5, offset));
      refinedLag = bestLag + offset;
    }
  }

  let bpm = (60 * (1000 / HOP_MS)) / refinedLag;
  // Fold into target range: double half-time, halve double-time.
  while (bpm < BPM_MIN) {
    bpm *= 2;
  }
  while (bpm > BPM_MAX) {
    bpm /= 2;
  }
  // If a single fold overshoots (e.g. 95 -> 190), nudge back into range.
  if (bpm > BPM_MAX) {
    bpm /= 2;
  }
  if (bpm < BPM_MIN) {
    bpm *= 2;
  }
  return Math.min(BPM_MAX, Math.max(BPM_MIN, bpm));
}

/** Best-phase beat grid: choose the phase offset maximizing onset energy on beats. Exported for tests. */
export function bestPhaseGrid(env: Float32Array, bpm: number, totalMs: number): number[] {
  const beatMs = 60000 / bpm;
  const beatHops = beatMs / HOP_MS;
  const phaseSteps = Math.max(1, Math.round(beatHops));

  let bestPhase = 0;
  let bestScore = -Infinity;
  for (let p = 0; p < phaseSteps; p++) {
    let acc = 0;
    for (let h = p; h < env.length; h += phaseSteps) {
      acc += env[Math.round(h)] ?? 0;
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

/** Pick onset peaks from the envelope as ms timestamps (local maxima above a floor). Exported for tests. */
export function pickOnsets(env: Float32Array): number[] {
  let mean = 0;
  for (let i = 0; i < env.length; i++) {
    mean += env[i];
  }
  mean /= Math.max(1, env.length);
  let variance = 0;
  for (let i = 0; i < env.length; i++) {
    variance += (env[i] - mean) ** 2;
  }
  const std = Math.sqrt(variance / Math.max(1, env.length));
  const threshold = mean + 0.6 * std;

  const onsets: number[] = [];
  const minGapHops = Math.max(1, Math.round(80 / HOP_MS)); // 80ms refractory
  let lastHop = -minGapHops;
  for (let h = 1; h < env.length - 1; h++) {
    if (
      env[h] > threshold &&
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

  // Normalized full-energy + per-band curves (per hop), for windowing + output.
  // bass = <150Hz (kick/sub), mid = 150Hz-2kHz (lead/vocal/snare body),
  // treble = >2kHz (hats/cymbals/air) — so a scene can map different instruments
  // to different elements (the music-driven win).
  const energyHop = new Float32Array(bands.full);
  const bassHop = new Float32Array(bands.bass);
  const midHop = new Float32Array(bands.mid);
  const trebleHop = new Float32Array(bands.high);

  // Per-band RAW crest factor (P98 / mean), computed BEFORE normalization while
  // the bands still carry their true dynamics. A dynamic track reads a high crest;
  // a flat one reads low. Shipped as `rawDynamicsHint` so the motion checker can
  // tell a genuinely flat track from one the normalizer flattened (the A↔C contract).
  const rawDynamicsHint = {
    bass: Number(crestFactor(bassHop).toFixed(4)),
    mid: Number(crestFactor(midHop).toFixed(4)),
    treble: Number(crestFactor(trebleHop).toFixed(4)),
  };

  normalizeInPlace(energyHop); // energy stays self-referenced (headline gesture, must reach 1.0)
  normalizeBandsShared([bassHop, midHop, trebleHop]); // ONE shared P97 reference + pow(0.7) lift

  const onsetEnvNorm = new Float32Array(env);
  normalizeInPlace(onsetEnvNorm); // flux delta envelope keeps its own scale

  const bpm = estimateBpm(env);

  // Window selection: best contiguous window scored by mean energy + 2*bass + onset density.
  const windowMs = Math.min(clampedTargetMs, totalMs);
  const windowHops = Math.max(1, Math.round(windowMs / HOP_MS));

  const onsetsAll = pickOnsets(env);

  let bestStartHop = 0;
  let bestScore = -Infinity;
  const lastStart = Math.max(0, bands.hopCount - windowHops);
  for (let s = 0; s <= lastStart; s++) {
    let energySum = 0;
    let bassSum = 0;
    for (let h = s; h < s + windowHops; h++) {
      energySum += energyHop[h] ?? 0;
      bassSum += bassHop[h] ?? 0;
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

  // Trim curves to the window, time-relative to startMs.
  const energyCurve: EnergySample[] = [];
  const bassCurve: EnergySample[] = [];
  const midCurve: EnergySample[] = [];
  const trebleCurve: EnergySample[] = [];
  const fluxCurve: EnergySample[] = [];
  const startHop = Math.round(startMs / HOP_MS);
  const endHop = Math.round(endMs / HOP_MS);
  for (let h = startHop; h < endHop && h < bands.hopCount; h++) {
    const timeMs = h * HOP_MS - startMs;
    energyCurve.push({ energy: Number((energyHop[h] ?? 0).toFixed(4)), timeMs });
    bassCurve.push({ energy: Number((bassHop[h] ?? 0).toFixed(4)), timeMs });
    midCurve.push({ energy: Number((midHop[h] ?? 0).toFixed(4)), timeMs });
    trebleCurve.push({ energy: Number((trebleHop[h] ?? 0).toFixed(4)), timeMs });
    fluxCurve.push({ energy: Number((onsetEnvNorm[h] ?? 0).toFixed(4)), timeMs });
  }

  // Beat grid across full clip, then trimmed/relative to the window.
  const fullGrid = bestPhaseGrid(onsetEnvNorm, bpm, totalMs);
  const beatGrid = fullGrid.flatMap((t) =>
    t >= startMs && t < endMs ? [Math.round(t - startMs)] : [],
  );

  const onsets = onsetsAll.flatMap((o) =>
    o >= startMs && o < endMs ? [Math.round(o - startMs)] : [],
  );

  return {
    bassCurve,
    beatGrid,
    bpm: Number(bpm.toFixed(2)),
    durationMs,
    energyCurve,
    file,
    fluxCurve,
    midCurve,
    onsets,
    rawDynamicsHint,
    startMs,
    trebleCurve,
  };
}
