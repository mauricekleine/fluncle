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

export {
  type Bands,
  type DecodedWav,
  computeBands,
  normalizeBandsShared,
  onsetEnvelope,
  percentile,
} from "./audio-curves";

const TARGET_WINDOW_MS = 20000;

const BPM_SEARCH_MIN = 60;
const BPM_SEARCH_MAX = 200;

const HALF_TIME_MIN = 70;
const HALF_TIME_MAX = 100;

export function decodeWav(buf: Buffer): DecodedWav {
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

  const availableBytes = Math.max(0, buf.length - dataOffset);
  if (dataLength > availableBytes) {
    throw new Error(
      `analyzeAudio: truncated wav — the data chunk header declares ${dataLength} bytes but only ${availableBytes} follow the data offset`,
    );
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
  bpm: number;

  confidence: number;
};

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

export function estimateBpmDetailed(env: Float32Array): BpmEstimate {
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
    return { bpm: lagToBpm(Math.max(1, lagMin)), confidence: 0 };
  }

  const nr = (lag: number): number =>
    lag >= centered.length || lag < 0 ? 0 : Math.max(0, autocorr(lag) / r0);

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

  const lo = Math.max(1, Math.floor(resolvedLag));
  const hi = Math.ceil(resolvedLag);
  const intLag = nr(hi) > nr(lo) ? hi : lo;

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
    const halfLag = refinedLag / 2;
    if (halfLag >= 1 && nrAt(halfLag) >= 0.4 * nr(intLag) && nrAt(halfLag) > 0.05) {
      bpm *= 2;
      folded = true;
    }
  }

  const peak = clamp01(nr(intLag));
  const harmonics = folded
    ? (clamp01(nrAt(refinedLag / 2)) + clamp01(nrAt(2 * refinedLag))) / 2
    : (clamp01(nrAt(2 * refinedLag)) + clamp01(nrAt(3 * refinedLag))) / 2;
  const confidence = clamp01(0.55 * peak + 0.45 * harmonics);

  return { bpm, confidence: Number(confidence.toFixed(3)) };
}

export function estimateBpm(env: Float32Array): number {
  return estimateBpmDetailed(env).bpm;
}

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

const ONSET_MEDIAN_HALF_MS = 750;
const ONSET_MEDIAN_STRIDE_HOPS = 8;

const ONSET_DELTA_FRACTION = 0.15;

function medianRange(arr: Float32Array, lo: number, hi: number): number {
  const from = Math.max(0, lo);
  const to = Math.min(arr.length, hi);
  if (to <= from) {
    return 0;
  }
  const slice = Float32Array.from(arr.subarray(from, to)).sort();
  return slice[slice.length >> 1] ?? 0;
}

export function pickOnsets(env: Float32Array): number[] {
  const n = env.length;
  if (n < 3) {
    return [];
  }

  const delta = ONSET_DELTA_FRACTION * percentile(env, 0.95);
  const halfHops = Math.max(1, Math.round(ONSET_MEDIAN_HALF_MS / HOP_MS));

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
  const minGapHops = Math.max(1, Math.round(80 / HOP_MS));
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

export type DropCandidate = { timeMs: number; score: number };

const DROP_NOVELTY_PRE_MS = 3_000;
const DROP_NOVELTY_POST_MS = 3_000;
const DROP_REENTRY_FLUX_MS = 800;
const DROP_BAR_SMOOTH_MS = 1_400;
const DROP_MIN_SPACING_MS = 2_000;
const DROP_MAX_CANDIDATES = 5;

const DROP_TAIL_GUARD_MS = 2_000;

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

  const rawDynamicsHint = {
    bass: Number(crestFactor(bands.bass).toFixed(4)),
    mid: Number(crestFactor(bands.mid).toFixed(4)),
    treble: Number(crestFactor(bands.high).toFixed(4)),
  };

  const energyFull = new Float32Array(bands.full);
  const bassFull = new Float32Array(bands.bass);
  const midFull = new Float32Array(bands.mid);
  const trebleFull = new Float32Array(bands.high);
  normalizeInPlace(energyFull);
  normalizeBandsShared([bassFull, midFull, trebleFull]);

  const { bpm, confidence: bpmConfidence } = estimateBpmDetailed(bands.superflux);
  const superfluxNorm = new Float32Array(bands.superflux);
  normalizeInPlace(superfluxNorm);

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

  const slice = (arr: Float32Array): Float32Array => arr.subarray(startHop, endHop);
  const energyWin = new Float32Array(slice(bands.full));
  const bassWin = new Float32Array(slice(bands.bass));
  const midWin = new Float32Array(slice(bands.mid));
  const trebleWin = new Float32Array(slice(bands.high));
  const fluxWin = new Float32Array(slice(env));
  normalizeInPlace(energyWin);
  normalizeBandsShared([bassWin, midWin, trebleWin]);
  normalizeInPlace(fluxWin);

  const kickEmph = emphasizeTransients(bands.kick);
  const snareEmph = emphasizeTransients(bands.snare);
  const subWin = new Float32Array(slice(bands.sub));
  const kickWin = new Float32Array(slice(kickEmph));
  const snareWin = new Float32Array(slice(snareEmph));
  const airWin = new Float32Array(slice(bands.air));
  normalizeBandsShared([subWin, kickWin, snareWin, airWin]);

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

  const fullGrid = bestPhaseGrid(superfluxNorm, bpm, totalMs);
  const beatGrid = fullGrid.flatMap((t) =>
    t >= startMs && t < endMs ? [Math.round(t - startMs)] : [],
  );

  const onsets = onsetsAll.flatMap((o) =>
    o >= startMs && o < endMs ? [Math.round(o - startMs)] : [],
  );

  const kickStrength = new Float32Array(bands.hopCount);
  for (let h = 1; h < bands.hopCount; h++) {
    const low = bands.sub[h] + bands.kick[h];
    const lowPrev = bands.sub[h - 1] + bands.kick[h - 1];
    kickStrength[h] = Math.max(0, low - lowPrev);
  }
  const downbeats = pickDownbeats(fullGrid, kickStrength).flatMap((t) =>
    t >= startMs && t < endMs ? [Math.round(t - startMs)] : [],
  );

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
