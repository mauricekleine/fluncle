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
import {
  type DecodedWav,
  HOP_MS,
  computeBands,
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
const BPM_MIN = 160;
const BPM_MAX = 185;

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
