import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type CosmosAudio, type EnergySample } from "../remotion/types";

import { extractGrayFrames, extractRgbFrames, type RgbFrames, structuralDelta } from "./frames";
import { type BeatPullResult, scoreBeatPull } from "./detect-beat-pull";
import { sha256File } from "./ship-gates";
import {
  type IntentBand,
  LIGHT_AXES,
  type RenderIntent,
  SMOOTHED_BANDS,
  STRUCTURAL_AXES,
  TEXTURE_AXES,
  validateRenderIntent,
} from "./intent";

const GATE_W = 48;
const GATE_H = 86;
const FLASH_W = 64;
const FLASH_H = 114;

const FLASH_FIELD_W = Math.round((341 / 1080) * FLASH_W);
const FLASH_FIELD_H = Math.round((256 / 1920) * FLASH_H);
const FLASH_FIELD_STRIDE = 4;

const FLASH_MAGNITUDE = 0.1;
const FLASH_DARK_STATE = 0.8;
const FLASH_DEADBAND = 0.02;
const FLASH_AREA = 0.25;
const FLASH_RATE_MAX = 3;

const RED_SATURATION = 0.8;
const RED_CHROMA_CHANGE = 0.2;

const NULL_N = 200;
const NULL_SEED = 0x9e3779b9;
const NULL_BLOCK = 8;
const ALIVE_PERCENTILE = 95;
const WEAK_PERCENTILE = 80;

const WINDOW_MS = 1000;
const DEAD_ENERGY = 0.6;

const RAW_CREST_FLAT = 1.4;
const LOW_MASS_THRESHOLD = 0.05;
const LOW_MASS_CRUSHED = 0.5;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(xs: number[]): number {
  if (xs.length === 0) {
    return 0;
  }
  let s = 0;
  for (const x of xs) {
    s += x;
  }
  return s / xs.length;
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) {
    return 0;
  }
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const den = Math.sqrt(da * db);
  if (den <= 1e-12) {
    return 0;
  }
  return num / den;
}

function percentileOf(value: number, dist: number[]): number {
  if (dist.length === 0) {
    return 0;
  }
  let below = 0;
  for (const d of dist) {
    if (d < value) {
      below += 1;
    }
  }
  return (below / dist.length) * 100;
}

function quantile(dist: number[], p: number): number {
  if (dist.length === 0) {
    return 0;
  }
  const sorted = [...dist].sort((x, y) => x - y);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

function sampleCurveAt(curve: EnergySample[], timeMs: number): number {
  if (curve.length === 0) {
    return 0;
  }
  const first = curve[0];
  if (timeMs <= first.timeMs) {
    return first.energy;
  }
  const last = curve[curve.length - 1];
  if (timeMs >= last.timeMs) {
    return last.energy;
  }
  for (let i = 1; i < curve.length; i++) {
    const next = curve[i];
    if (timeMs <= next.timeMs) {
      const prev = curve[i - 1];
      const span = next.timeMs - prev.timeMs;
      if (span <= 0) {
        return next.energy;
      }
      const t = (timeMs - prev.timeMs) / span;
      return prev.energy + (next.energy - prev.energy) * t;
    }
  }
  return last.energy;
}

function resampleToFrames(curve: EnergySample[], frameCount: number, fps: number): number[] {
  const out: number[] = [];
  for (let f = 0; f < frameCount; f++) {
    out.push(sampleCurveAt(curve, (f / fps) * 1000));
  }
  return out;
}

const BAND_SMOOTHING_FRAMES: Record<IntentBand, number> = {
  bass: 3,
  bassFast: 1,
  drop: 4,
  energy: 4,
  flux: 2,
  hit: 1,
  mid: 3,
  midFast: 1,
  onset: 1,
  swell: 4,
  treble: 2,
  trebleFast: 1,
};

function bandCurve(audio: CosmosAudio, band: IntentBand): EnergySample[] {
  switch (band) {
    case "bass":
    case "bassFast":
      return audio.bassCurve;
    case "mid":
    case "midFast":
      return audio.midCurve;
    case "treble":
    case "trebleFast":
      return audio.trebleCurve;
    case "flux":
      return audio.fluxCurve ?? [];
    case "energy":
    case "swell":
    case "drop":
    case "hit":
    case "onset":
    default:
      return audio.energyCurve;
  }
}

function lagFramesFor(band: IntentBand): number {
  return Math.max(0, Math.round(BAND_SMOOTHING_FRAMES[band]));
}

export type FlashSafetyResult = {
  deterministic: true;
  hard: true;
  unsafe: boolean;
  verdict: "safe" | "unsafe";
  maxGeneralFlashesPerSec: number;
  maxRedFlashesPerSec: number;
  rawFlashesPerSec: number;
  worstWindowArea: number;
  worstWindowStartMs: number;
  grainFloor: number;
  aaaStricterFlag: boolean;
};

function srgbToLinear(c8: number): number {
  const c = c8 / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relLuminance(r: number, g: number, b: number): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function uvPrime(r: number, g: number, b: number): { u: number; v: number } {
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);
  const X = 0.4124 * rl + 0.3576 * gl + 0.1805 * bl;
  const Y = 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
  const Z = 0.0193 * rl + 0.1192 * gl + 0.9505 * bl;
  const den = X + 15 * Y + 3 * Z;
  if (den <= 1e-9) {
    return { u: 0, v: 0 };
  }
  return { u: (4 * X) / den, v: (9 * Y) / den };
}

type FlashPerPixel = {
  width: number;
  height: number;

  lum: Float32Array[];

  red: Float32Array[];

  u: Float32Array[];

  v: Float32Array[];

  meanL: number[];

  meanRed: number[];
};

function decodeFlashFrames(rgb: RgbFrames): FlashPerPixel {
  const { width, height, frames } = rgb;
  const pixels = width * height;
  const lum: Float32Array[] = [];
  const red: Float32Array[] = [];
  const u: Float32Array[] = [];
  const v: Float32Array[] = [];
  const meanL: number[] = [];
  const meanRed: number[] = [];

  for (const frame of frames) {
    const fl = new Float32Array(pixels);
    const fr = new Float32Array(pixels);
    const fu = new Float32Array(pixels);
    const fv = new Float32Array(pixels);
    let sumL = 0;
    let sumRed = 0;
    for (let p = 0; p < pixels; p++) {
      const r = frame[p * 3];
      const g = frame[p * 3 + 1];
      const b = frame[p * 3 + 2];
      const L = relLuminance(r, g, b);
      fl[p] = L;
      sumL += L;
      const total = r + g + b;
      const sat = total > 1e-6 ? r / total : 0;
      const isRed = sat >= RED_SATURATION ? 1 : 0;
      fr[p] = isRed;
      sumRed += isRed;
      const { u: up, v: vp } = uvPrime(r, g, b);
      fu[p] = up;
      fv[p] = vp;
    }
    lum.push(fl);
    red.push(fr);
    u.push(fu);
    v.push(fv);
    meanL.push(sumL / pixels);
    meanRed.push(sumRed / pixels);
  }

  return { height, lum, meanL, meanRed, red, u, v, width };
}

type Extremum = { frame: number; value: number };

function extremaWithDeadband(series: number[], deadband: number): Extremum[] {
  const n = series.length;
  if (n === 0) {
    return [];
  }
  const out: Extremum[] = [{ frame: 0, value: series[0] }];
  let lastExt = series[0];
  let dir = 0;
  for (let i = 1; i < n; i++) {
    const x = series[i];
    const diff = x - lastExt;
    if (dir >= 0 && diff > deadband) {
      if (dir === 0) {
        dir = 1;
      }
      lastExt = x;
      out[out.length - 1] = { frame: i, value: x };
    } else if (dir <= 0 && -diff > deadband) {
      if (dir === 0) {
        dir = -1;
      }
      lastExt = x;
      out[out.length - 1] = { frame: i, value: x };
    } else if (dir > 0 && -diff > deadband) {
      out.push({ frame: i, value: x });
      lastExt = x;
      dir = -1;
    } else if (dir < 0 && diff > deadband) {
      out.push({ frame: i, value: x });
      lastExt = x;
      dir = 1;
    }
  }
  return out;
}

type FlashEvent = { midFrame: number; peakFrame: number; valleyFrame: number; magnitude: number };

function countFlashes(series: number[], mag: number, darkLimit: number): FlashEvent[] {
  const ext = extremaWithDeadband(series, FLASH_DEADBAND);
  const flashes: FlashEvent[] = [];

  for (let i = 2; i < ext.length; i++) {
    const a = ext[i - 2];
    const b = ext[i - 1];
    const c = ext[i];
    const t1 = Math.abs(b.value - a.value);
    const t2 = Math.abs(c.value - b.value);
    const opposing = Math.sign(b.value - a.value) === -Math.sign(c.value - b.value);
    const darker1 = Math.min(a.value, b.value);
    const darker2 = Math.min(b.value, c.value);
    if (opposing && t1 >= mag && t2 >= mag && darker1 < darkLimit && darker2 < darkLimit) {
      flashes.push({
        magnitude: Math.min(t1, t2),
        midFrame: b.frame,
        peakFrame: b.value >= a.value ? b.frame : a.frame,
        valleyFrame: b.value >= a.value ? c.frame : b.frame,
      });
    }
  }
  return flashes;
}

function maxFlashesPerSecond(flashes: FlashEvent[], fps: number): number {
  if (flashes.length === 0) {
    return 0;
  }
  const windowFrames = Math.max(1, Math.round((WINDOW_MS / 1000) * fps));
  let max = 0;
  for (const anchor of flashes) {
    let count = 0;
    for (const f of flashes) {
      if (f.midFrame >= anchor.midFrame && f.midFrame < anchor.midFrame + windowFrames) {
        count += 1;
      }
    }
    if (count > max) {
      max = count;
    }
  }
  return max;
}

function worstWindowFlashFraction(
  peakLum: Float32Array,
  valleyLum: Float32Array,
  width: number,
  height: number,
): number {
  const fieldW = Math.min(width, Math.max(1, FLASH_FIELD_W));
  const fieldH = Math.min(height, Math.max(1, FLASH_FIELD_H));
  let worst = 0;
  for (let y0 = 0; y0 + fieldH <= height; y0 += FLASH_FIELD_STRIDE) {
    for (let x0 = 0; x0 + fieldW <= width; x0 += FLASH_FIELD_STRIDE) {
      let flashing = 0;
      let total = 0;
      for (let y = y0; y < y0 + fieldH; y++) {
        for (let x = x0; x < x0 + fieldW; x++) {
          const idx = y * width + x;
          const pl = peakLum[idx];
          const vl = valleyLum[idx];
          const dL = Math.abs(pl - vl);
          const darker = Math.min(pl, vl);
          if (dL >= FLASH_MAGNITUDE && darker < FLASH_DARK_STATE) {
            flashing += 1;
          }
          total += 1;
        }
      }
      if (total > 0) {
        const frac = flashing / total;
        if (frac > worst) {
          worst = frac;
        }
      }
    }
  }
  return worst;
}

function grainFloor(perFrame: FlashPerPixel): number {
  const stds: number[] = [];
  for (let f = 0; f < perFrame.lum.length; f++) {
    const arr = perFrame.lum[f];
    const m = perFrame.meanL[f];
    let s = 0;
    for (let p = 0; p < arr.length; p++) {
      const d = arr[p] - m;
      s += d * d;
    }
    stds.push(Math.sqrt(s / arr.length));
  }
  if (stds.length === 0) {
    return 0;
  }
  const sorted = [...stds].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function scoreFlashSafety(rgb: RgbFrames): FlashSafetyResult {
  const perFrame = decodeFlashFrames(rgb);
  const fps = rgb.fps;
  const { width, height, lum, meanL, meanRed } = perFrame;

  const generalFlashes = countFlashes(meanL, FLASH_MAGNITUDE, FLASH_DARK_STATE);

  let worstWindowArea = 0;
  let worstWindowStartMs = 0;
  const areaQualified: FlashEvent[] = [];
  for (const flash of generalFlashes) {
    const frac = worstWindowFlashFraction(
      lum[flash.peakFrame],
      lum[flash.valleyFrame],
      width,
      height,
    );
    if (frac >= FLASH_AREA) {
      areaQualified.push(flash);
    }
    if (frac > worstWindowArea) {
      worstWindowArea = frac;
      worstWindowStartMs = Math.round((flash.midFrame / fps) * 1000);
    }
  }
  const maxGeneral = maxFlashesPerSecond(areaQualified, fps);

  const redCandidates = countFlashes(meanRed, FLASH_MAGNITUDE, 1.0);
  const redQualified: FlashEvent[] = [];
  for (const flash of redCandidates) {
    const peakU = mean([...perFrame.u[flash.peakFrame]]);
    const peakV = mean([...perFrame.v[flash.peakFrame]]);
    const valU = mean([...perFrame.u[flash.valleyFrame]]);
    const valV = mean([...perFrame.v[flash.valleyFrame]]);
    const chroma = Math.hypot(peakU - valU, peakV - valV);
    if (chroma <= RED_CHROMA_CHANGE) {
      continue;
    }
    const frac = worstWindowRedFraction(
      perFrame.red[flash.peakFrame],
      perFrame.red[flash.valleyFrame],
      width,
      height,
    );
    if (frac >= FLASH_AREA) {
      redQualified.push(flash);
    }
    if (frac > worstWindowArea) {
      worstWindowArea = frac;
      worstWindowStartMs = Math.round((flash.midFrame / fps) * 1000);
    }
  }
  const maxRed = maxFlashesPerSecond(redQualified, fps);

  const rawFlashes = countFlashes(meanL, FLASH_DEADBAND, 1.0);
  const rawFlashesPerSec = maxFlashesPerSecond(rawFlashes, fps);

  const unsafe =
    (maxGeneral > FLASH_RATE_MAX || maxRed > FLASH_RATE_MAX) && worstWindowArea >= FLASH_AREA;

  return {
    aaaStricterFlag: rawFlashesPerSec > FLASH_RATE_MAX,
    deterministic: true,
    grainFloor: grainFloor(perFrame),
    hard: true,
    maxGeneralFlashesPerSec: maxGeneral,
    maxRedFlashesPerSec: maxRed,
    rawFlashesPerSec,
    unsafe,
    verdict: unsafe ? "unsafe" : "safe",
    worstWindowArea,
    worstWindowStartMs,
  };
}

function worstWindowRedFraction(
  peakRed: Float32Array,
  valleyRed: Float32Array,
  width: number,
  height: number,
): number {
  const fieldW = Math.min(width, Math.max(1, FLASH_FIELD_W));
  const fieldH = Math.min(height, Math.max(1, FLASH_FIELD_H));
  let worst = 0;
  for (let y0 = 0; y0 + fieldH <= height; y0 += FLASH_FIELD_STRIDE) {
    for (let x0 = 0; x0 + fieldW <= width; x0 += FLASH_FIELD_STRIDE) {
      let flashing = 0;
      let total = 0;
      for (let y = y0; y < y0 + fieldH; y++) {
        for (let x = x0; x < x0 + fieldW; x++) {
          const idx = y * width + x;
          if (peakRed[idx] !== valleyRed[idx]) {
            flashing += 1;
          }
          total += 1;
        }
      }
      if (total > 0) {
        const frac = flashing / total;
        if (frac > worst) {
          worst = frac;
        }
      }
    }
  }
  return worst;
}

export type CouplingResult = {
  deterministic: true;
  hard: false;

  coupling: number;

  couplingZ: number;

  couplingPercentile: number;
  headlineBand: IntentBand;

  intentDeclaredBand: IntentBand | null;
  lagFrames: number;
  lagMs: number;

  diagnostics: { energy: number; bass: number; flux: number };
  pictureActivity: number;
  verdict: "alive" | "weak" | "dead";
  nullDesc: string;
  deadZones: DeadZone[];
  attribution: CouplingAttribution;

  provisionalThresholds: { alive: number; weak: number };
};

export type DeadZone = {
  startMs: number;
  endMs: number;
  audioEnergy: number;
  coupling: number;
  overlapsDrop: boolean;
};

export type CouplingAttribution = {
  attributedLayer: 1 | 2 | null;
  reason: string;
  lowMassTail: number;
  rawCrest: number | null;
};

function laggedPearson(delta: number[], curve: number[], lag: number): number {
  const n = delta.length;
  if (n < 4) {
    return 0;
  }
  const a: number[] = [];
  const b: number[] = [];
  for (let f = lag; f < n; f++) {
    a.push(delta[f]);
    b.push(curve[f - lag]);
  }
  return pearson(a, b);
}

function blockShuffle(series: number[], block: number, rng: () => number): number[] {
  const blocks: number[][] = [];
  for (let i = 0; i < series.length; i += block) {
    blocks.push(series.slice(i, i + block));
  }

  for (let i = blocks.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = blocks[i];
    blocks[i] = blocks[j];
    blocks[j] = tmp;
  }
  const out: number[] = [];
  for (const b of blocks) {
    for (const v of b) {
      out.push(v);
    }
  }
  return out.slice(0, series.length);
}

export type CouplingInput = {
  delta: number[];
  audio: CosmosAudio;
  fps: number;
  intent: RenderIntent | null;
};

export function scoreCoupling(input: CouplingInput): CouplingResult {
  const { delta, audio, fps, intent } = input;

  let intentDeclaredBand: IntentBand | null = null;
  if (intent) {
    const structuralBinding = intent.bindings.find((bnd) => STRUCTURAL_AXES.includes(bnd.axis));
    if (structuralBinding) {
      intentDeclaredBand = structuralBinding.band;
    }
  }
  const headlineBand: IntentBand = intentDeclaredBand ?? "energy";

  const curveFull = resampleToFrames(bandCurve(audio, headlineBand), delta.length, fps);
  const lag = lagFramesFor(headlineBand);
  const lagMs = Math.round((lag / fps) * 1000);

  const coupling = laggedPearson(delta, curveFull, lag);

  const eCurve = resampleToFrames(audio.energyCurve, delta.length, fps);
  const bCurve = resampleToFrames(audio.bassCurve, delta.length, fps);
  const fCurve = resampleToFrames(audio.fluxCurve ?? [], delta.length, fps);
  const diagnostics = {
    bass: laggedPearson(delta, bCurve, lagFramesFor("bass")),
    energy: laggedPearson(delta, eCurve, lagFramesFor("energy")),
    flux: laggedPearson(delta, fCurve, lagFramesFor("flux")),
  };

  const rng = mulberry32(NULL_SEED);
  const nullDist: number[] = [];
  for (let i = 0; i < NULL_N; i++) {
    const shuffled = blockShuffle(curveFull, NULL_BLOCK, rng);
    nullDist.push(laggedPearson(delta, shuffled, lag));
  }
  const nullMean = mean(nullDist);
  let nullVar = 0;
  for (const x of nullDist) {
    nullVar += (x - nullMean) ** 2;
  }
  nullVar /= Math.max(1, nullDist.length);
  const nullStd = Math.sqrt(nullVar);
  const couplingZ = nullStd > 1e-9 ? (coupling - nullMean) / nullStd : 0;
  const couplingPercentile = percentileOf(coupling, nullDist);

  const aliveCut = quantile(nullDist, ALIVE_PERCENTILE);
  const weakCut = quantile(nullDist, WEAK_PERCENTILE);

  let verdict: "alive" | "weak" | "dead";
  if (coupling > 1e-6 && couplingPercentile >= ALIVE_PERCENTILE) {
    verdict = "alive";
  } else if (coupling > 1e-6 && couplingPercentile >= WEAK_PERCENTILE) {
    verdict = "weak";
  } else {
    verdict = "dead";
  }

  const pictureActivity = mean(delta);

  const deadZones = findDeadZones(delta, eCurve, headlineBand, fps, intent, aliveCut);

  const attribution = attribute(
    couplingZ,
    couplingPercentile,
    curveFull,
    audio.rawDynamicsHint,
    headlineBand,
  );

  return {
    attribution,
    coupling,
    couplingPercentile,
    couplingZ,
    deadZones,
    deterministic: true,
    diagnostics,
    hard: false,
    headlineBand,
    intentDeclaredBand,
    lagFrames: lag,
    lagMs,
    nullDesc: `block-shuffle (block=${NULL_BLOCK}f), mulberry32 seed=0x${NULL_SEED.toString(16)}, N=${NULL_N}; alive>=P${ALIVE_PERCENTILE} (~${100 - ALIVE_PERCENTILE}% FP), weak>=P${WEAK_PERCENTILE}`,
    pictureActivity,
    provisionalThresholds: { alive: aliveCut, weak: weakCut },
    verdict,
  };
}

function findDeadZones(
  delta: number[],
  eCurve: number[],
  headlineBand: IntentBand,
  fps: number,
  intent: RenderIntent | null,
  aliveCut: number,
): DeadZone[] {
  const windowFrames = Math.max(2, Math.round((WINDOW_MS / 1000) * fps));
  const zones: DeadZone[] = [];
  const lag = lagFramesFor(headlineBand);
  for (let start = 0; start + windowFrames <= delta.length; start += windowFrames) {
    const end = start + windowFrames;
    const winDelta = delta.slice(start, end);
    const winCurve = eCurve.slice(start, end);
    const audioEnergy = mean(winCurve);
    if (audioEnergy < DEAD_ENERGY) {
      continue;
    }
    const winCoupling = laggedPearson(winDelta, winCurve, Math.min(lag, windowFrames - 2));
    if (winCoupling < aliveCut) {
      const startMs = Math.round((start / fps) * 1000);
      const endMs = Math.round((end / fps) * 1000);
      const overlapsDrop =
        intent !== null && intent.dropMs >= startMs - 500 && intent.dropMs <= endMs + 1000;
      zones.push({ audioEnergy, coupling: winCoupling, endMs, overlapsDrop, startMs });
    }
  }
  return zones;
}

function attribute(
  couplingZ: number,
  couplingPercentile: number,
  curve: number[],
  rawHint: CosmosAudio["rawDynamicsHint"],
  headlineBand: IntentBand,
): CouplingAttribution {
  if (couplingPercentile >= ALIVE_PERCENTILE) {
    return {
      attributedLayer: null,
      lowMassTail: lowMassTail(curve),
      rawCrest: rawCrestFor(rawHint, headlineBand),
      reason: `coupling clears the null (P${couplingPercentile.toFixed(0)}, z=${couplingZ.toFixed(2)}) — alive`,
    };
  }

  const tail = lowMassTail(curve);
  const rawCrest = rawCrestFor(rawHint, headlineBand);

  if (rawCrest !== null && rawCrest < RAW_CREST_FLAT) {
    return {
      attributedLayer: 1,
      lowMassTail: tail,
      rawCrest,
      reason: `low coupling (z=${couplingZ.toFixed(2)}); raw crest ${rawCrest.toFixed(2)} < ${RAW_CREST_FLAT} — the track was flat (Layer 1: signal)`,
    };
  }

  if (rawCrest !== null && rawCrest >= RAW_CREST_FLAT && tail >= LOW_MASS_CRUSHED) {
    return {
      attributedLayer: 1,
      lowMassTail: tail,
      rawCrest,
      reason: `low coupling (z=${couplingZ.toFixed(2)}); raw crest ${rawCrest.toFixed(2)} dynamic but normalized curve crushed (${(tail * 100).toFixed(0)}% low-mass tail) — the normalizer flattened it (Layer 1: prime flattener)`,
    };
  }

  return {
    attributedLayer: 2,
    lowMassTail: tail,
    rawCrest,
    reason: `low coupling (z=${couplingZ.toFixed(2)}); curve is dynamic (${(tail * 100).toFixed(0)}% low-mass tail${rawCrest !== null ? `, raw crest ${rawCrest.toFixed(2)}` : ""}) but the picture ignores it (Layer 2: binding)`,
  };
}

function lowMassTail(curve: number[]): number {
  if (curve.length === 0) {
    return 0;
  }
  let max = 0;
  for (const x of curve) {
    if (x > max) {
      max = x;
    }
  }
  if (max <= 1e-9) {
    return 1;
  }
  const floor = LOW_MASS_THRESHOLD * max;
  let below = 0;
  for (const x of curve) {
    if (x < floor) {
      below += 1;
    }
  }
  return below / curve.length;
}

function rawCrestFor(
  rawHint: CosmosAudio["rawDynamicsHint"],
  headlineBand: IntentBand,
): number | null {
  if (!rawHint) {
    return null;
  }
  switch (headlineBand) {
    case "bass":
    case "bassFast":
      return rawHint.bass;
    case "mid":
    case "midFast":
      return rawHint.mid;
    case "treble":
    case "trebleFast":
      return rawHint.treble;
    default:
      return Math.max(rawHint.bass, rawHint.mid, rawHint.treble);
  }
}

export type IntentBindingCheck = {
  band: IntentBand;
  element: string;
  axis: string;
  intendedStrength: "subtle" | "strong";
  actualCoupling: number;
  couplingPercentile: number;
  discriminates: boolean;
  discriminatesConfidence: "low-confidence on short clips";
  pass: boolean;
};

export type IntentCheckResult = {
  deterministic: true;
  hard: false;
  dropMs: number;
  drop: {
    pass: boolean;
    dropStructural: number;
    dropLuminance: number;
    actualPeakMs: number;
  };
  arcPeakAlignmentMs: number;
  translationTripwire: { pass: boolean; violations: string[] };
  axisCoverage: {
    pass: boolean;
    structural: boolean;
    light: boolean;
    texture: boolean;
  };
  bindings: IntentBindingCheck[];
  deferToJudge: string[];
};

export type IntentCheckInput = {
  intent: RenderIntent;
  delta: number[];
  meanL: number[];
  audio: CosmosAudio;
  fps: number;
};

export function checkIntent(input: IntentCheckInput): IntentCheckResult {
  const { intent, delta, meanL, audio, fps } = input;

  const winStart = Math.max(0, Math.round(((intent.dropMs - 500) / 1000) * fps));
  const winEnd = Math.min(delta.length, Math.round(((intent.dropMs + 1000) / 1000) * fps));
  const deltaBaseline = median(delta) || 1e-9;
  let dropStructural = 0;
  let peakFrame = winStart;
  for (let f = winStart; f < winEnd && f < delta.length; f++) {
    const ratio = delta[f] / deltaBaseline;
    if (ratio > dropStructural) {
      dropStructural = ratio;
      peakFrame = f;
    }
  }

  const lumDeltas: number[] = [];
  for (let f = 1; f < meanL.length; f++) {
    lumDeltas.push(Math.abs(meanL[f] - meanL[f - 1]));
  }
  const lumBaseline = median(lumDeltas) || 1e-9;
  let dropLuminance = 0;
  const lumWinStart = Math.max(1, winStart);
  const lumWinEnd = Math.min(meanL.length, winEnd);
  for (let f = lumWinStart; f < lumWinEnd; f++) {
    const ratio = Math.abs(meanL[f] - meanL[f - 1]) / lumBaseline;
    if (ratio > dropLuminance) {
      dropLuminance = ratio;
    }
  }

  let globalPeakFrame = 0;
  let globalPeak = -1;
  for (let f = 0; f < delta.length; f++) {
    if (delta[f] > globalPeak) {
      globalPeak = delta[f];
      globalPeakFrame = f;
    }
  }
  const actualPeakMs = Math.round((globalPeakFrame / fps) * 1000);
  const arcPeakAlignmentMs = Math.abs(actualPeakMs - intent.dropMs);

  const dropPass = dropStructural >= 2.0 || dropLuminance >= 1.5;

  const violations: string[] = [];
  for (const bnd of intent.bindings) {
    if (bnd.axis === "translation" && !SMOOTHED_BANDS.includes(bnd.band)) {
      violations.push(`${bnd.band}→translation (${bnd.element})`);
    }
  }

  let hasStructural = false;
  let hasLight = false;
  let hasTexture = false;
  for (const bnd of intent.bindings) {
    if (STRUCTURAL_AXES.includes(bnd.axis)) {
      hasStructural = true;
    }
    if (LIGHT_AXES.includes(bnd.axis)) {
      hasLight = true;
    }
    if (TEXTURE_AXES.includes(bnd.axis)) {
      hasTexture = true;
    }
  }

  const bandList: IntentBand[] = ["energy", "bass", "mid", "treble", "flux"];
  const bindings: IntentBindingCheck[] = intent.bindings.map((bnd) => {
    const claimed = laggedPearson(
      delta,
      resampleToFrames(bandCurve(audio, bnd.band), delta.length, fps),
      lagFramesFor(bnd.band),
    );

    let maxOther = -2;
    for (const other of bandList) {
      if (other === bnd.band) {
        continue;
      }
      const r = laggedPearson(
        delta,
        resampleToFrames(bandCurve(audio, other), delta.length, fps),
        lagFramesFor(other),
      );
      if (r > maxOther) {
        maxOther = r;
      }
    }

    const floor = bnd.intendedStrength === "strong" ? 0.3 : 0.15;
    return {
      actualCoupling: claimed,
      axis: bnd.axis,
      band: bnd.band,
      couplingPercentile: 0,
      discriminates: claimed >= maxOther,
      discriminatesConfidence: "low-confidence on short clips",
      element: bnd.element,
      intendedStrength: bnd.intendedStrength,
      pass: claimed >= floor,
    };
  });

  return {
    arcPeakAlignmentMs,
    axisCoverage: {
      light: hasLight,
      pass: hasStructural && hasLight && hasTexture,
      structural: hasStructural,
      texture: hasTexture,
    },
    bindings,
    deferToJudge: [
      "aesthetic quality (liquid/lava-lamp vs HTML-y/static — Maurice's taste)",
      "whether the structural change is the INTENDED kind (warp vs hue vs edge — band correlation can't tell)",
      "binding semantic correctness beyond band correlation",
      "narrative arc quality beyond the drop spike",
    ],
    deterministic: true,
    drop: {
      actualPeakMs: Math.round((peakFrame / fps) * 1000),
      dropLuminance,
      dropStructural,
      pass: dropPass,
    },
    dropMs: intent.dropMs,
    hard: false,
    translationTripwire: { pass: violations.length === 0, violations },
  };
}

function median(xs: number[]): number {
  if (xs.length === 0) {
    return 0;
  }
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export type BeatReactivity = {
  deterministic: true;
  hard: false;

  beatGridCoupling: number;
  structuralBeatContrast: number;
  luminanceBeatContrast: number;

  beatPercentile: number;
  verdict: "reactive" | "weak" | "dead";

  arcScore: number;
  arcActivityDelta: number;
  arcLumaDelta: number;
  dropMs: number;
  dropSource: "intent" | "energyPeak";
  nullDesc: string;
};

function minMaxNorm(xs: number[]): number[] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of xs) {
    if (x < lo) {
      lo = x;
    }
    if (x > hi) {
      hi = x;
    }
  }
  const span = hi - lo;
  if (span <= 1e-9) {
    return xs.map(() => 0);
  }
  return xs.map((x) => (x - lo) / span);
}

function onOffBeatMean(
  signal: number[],
  beatFrames: number[],
  halfWin: number,
): { on: number; off: number } {
  const onMask = Array.from<boolean>({ length: signal.length }).fill(false);
  for (const bf of beatFrames) {
    for (let d = -halfWin; d <= halfWin; d++) {
      const f = bf + d;
      if (f >= 0 && f < signal.length) {
        onMask[f] = true;
      }
    }
  }
  let onSum = 0;
  let onN = 0;
  let offSum = 0;
  let offN = 0;
  for (let f = 0; f < signal.length; f++) {
    if (onMask[f]) {
      onSum += signal[f];
      onN += 1;
    } else {
      offSum += signal[f];
      offN += 1;
    }
  }
  return { off: offN > 0 ? offSum / offN : 0, on: onN > 0 ? onSum / onN : 0 };
}

function contrast(hiVal: number, loVal: number): number {
  const denom = hiVal + loVal;
  return denom > 1e-9 ? (hiVal - loVal) / denom : 0;
}

export type BeatReactivityInput = {
  delta: number[];
  meanL: number[];
  audio: CosmosAudio;
  fps: number;
  intent: RenderIntent | null;
};

export function scoreBeatReactivity(input: BeatReactivityInput): BeatReactivity {
  const { delta, meanL, audio, fps, intent } = input;
  const n = delta.length;

  const lumaDelta: number[] = [];
  for (let i = 0; i < n; i++) {
    lumaDelta.push(Math.abs((meanL[i + 1] ?? meanL[i] ?? 0) - (meanL[i] ?? 0)));
  }
  const structN = minMaxNorm(delta);
  const lumaN = minMaxNorm(lumaDelta);
  const combined = structN.map((s, i) => s + (lumaN[i] ?? 0));

  const beatFrames = audio.beatGrid
    .map((ms) => Math.round((ms / 1000) * fps))
    .filter((f) => f >= 0 && f < n);
  const halfWin = Math.max(1, Math.round(fps * 0.06));

  const structPair = onOffBeatMean(structN, beatFrames, halfWin);
  const lumaPair = onOffBeatMean(lumaN, beatFrames, halfWin);
  const combPair = onOffBeatMean(combined, beatFrames, halfWin);
  const structuralBeatContrast = contrast(structPair.on, structPair.off);
  const luminanceBeatContrast = contrast(lumaPair.on, lumaPair.off);
  const beatGridCoupling = contrast(combPair.on, combPair.off);

  let beatPercentile = 0;
  if (beatFrames.length >= 2 && n > 4) {
    const rng = mulberry32(NULL_SEED ^ 0x5bd1e995);
    const nullDist: number[] = [];
    for (let k = 0; k < NULL_N; k++) {
      const shift = 1 + Math.floor(rng() * (n - 1));
      const shifted = beatFrames.map((f) => (f + shift) % n);
      nullDist.push(onOffBeatMean(combined, shifted, halfWin).on);
    }
    beatPercentile = percentileOf(combPair.on, nullDist);
  }
  let verdict: "reactive" | "weak" | "dead";
  if (beatGridCoupling > 0 && beatPercentile >= 90) {
    verdict = "reactive";
  } else if (beatGridCoupling > 0 && beatPercentile >= 70) {
    verdict = "weak";
  } else {
    verdict = "dead";
  }

  let dropMs = intent && intent.dropMs > 0 ? intent.dropMs : 0;
  let dropSource: "intent" | "energyPeak" = "intent";
  if (dropMs <= 0) {
    dropSource = "energyPeak";
    let peak = -Infinity;
    let peakMs = 0;
    for (const s of audio.energyCurve) {
      if (s.energy > peak) {
        peak = s.energy;
        peakMs = s.timeMs;
      }
    }
    dropMs = peakMs;
  }
  const dropFrame = Math.min(n - 1, Math.max(0, Math.round((dropMs / 1000) * fps)));
  const arcActivityDelta = contrast(
    mean(combined.slice(dropFrame)),
    mean(combined.slice(0, dropFrame)),
  );
  const lumaCut = Math.min(meanL.length, dropFrame + 1);
  const arcLumaDelta = contrast(mean(meanL.slice(lumaCut)), mean(meanL.slice(0, lumaCut)));
  const arcScore = Math.max(0, 0.6 * arcActivityDelta + 0.4 * arcLumaDelta);

  return {
    arcActivityDelta: Number(arcActivityDelta.toFixed(4)),
    arcLumaDelta: Number(arcLumaDelta.toFixed(4)),
    arcScore: Number(arcScore.toFixed(4)),
    beatGridCoupling: Number(beatGridCoupling.toFixed(4)),
    beatPercentile: Number(beatPercentile.toFixed(1)),
    deterministic: true,
    dropMs,
    dropSource,
    hard: false,
    luminanceBeatContrast: Number(luminanceBeatContrast.toFixed(4)),
    nullDesc: `phase-shuffle beat-grid, mulberry32, N=${NULL_N}; on-beat window ±${halfWin}f; reactive>=P90`,
    structuralBeatContrast: Number(structuralBeatContrast.toFixed(4)),
    verdict,
  };
}

export const ARC_ANCHOR_PCTS = [0.05, 0.25, 0.5, 0.75, 0.95] as const;
const ARC_COLOR_WEIGHT = 0.25;
const ARC_FLOOR = 0.29;

const ARC_REGION_FLOOR = 0.5;

const ARC_PRESENCE_STRIKING = 0.4;
const ARC_WINDOW_DIV = 3;
const ARC_WINDOW_STRIDE_DIV = 2;
const ARC_MIN_FRAMES = 10;

const ARC_HUE_BINS = 8;
const ARC_SAT_BINS = 4;
const ARC_VAL_BINS = 4;

export type ArcSegmentChange = {
  grayMad: number;
  edgeMad: number;
  colorDist: number;
  combined: number;
};

export type ArcIntentCheck = {
  declared: boolean;
  dropMs: number;

  dropSegment: number;
  dropSegmentChange: number;

  meetsArc: boolean;
};

export type ArcResult = {
  deterministic: true;
  hard: true;
  dead: boolean;
  verdict: "evolving" | "dead" | "inconclusive";

  inconclusive?: string;

  wholeClipChange: number;

  minSegmentChange: number;

  bestWindowChange: number;
  floor: number;

  regionFloor: number;
  anchorPcts: number[];
  anchorFrames: number[];
  segments: ArcSegmentChange[];
  intentArc: ArcIntentCheck | null;
};

function arcLumaPlane(frame: Float32Array, width: number, height: number): Float32Array {
  const pix = width * height;
  const gray = new Float32Array(pix);
  for (let p = 0; p < pix; p++) {
    gray[p] = (0.299 * frame[p * 3] + 0.587 * frame[p * 3 + 1] + 0.114 * frame[p * 3 + 2]) / 255;
  }
  const out = new Float32Array(pix);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy >= 0 && yy < height && xx >= 0 && xx < width) {
            sum += gray[yy * width + xx];
            n += 1;
          }
        }
      }
      out[y * width + x] = sum / n;
    }
  }
  return out;
}

function sobelMap(plane: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(plane.length);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx =
        -plane[i - width - 1] -
        2 * plane[i - 1] -
        plane[i + width - 1] +
        plane[i - width + 1] +
        2 * plane[i + 1] +
        plane[i + width + 1];
      const gy =
        -plane[i - width - 1] -
        2 * plane[i - width] -
        plane[i - width + 1] +
        plane[i + width - 1] +
        2 * plane[i + width] +
        plane[i + width + 1];
      out[i] = Math.hypot(gx, gy);
    }
  }
  return out;
}

function hsvHistogram(frame: Float32Array, width: number, height: number): Float32Array {
  const pix = width * height;
  const hist = new Float32Array(ARC_HUE_BINS * ARC_SAT_BINS * ARC_VAL_BINS);
  for (let p = 0; p < pix; p++) {
    const r = frame[p * 3] / 255;
    const g = frame[p * 3 + 1] / 255;
    const b = frame[p * 3 + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const c = max - min;
    let hue = 0;
    if (c > 1e-6) {
      if (max === r) {
        hue = ((g - b) / c) % 6;
      } else if (max === g) {
        hue = (b - r) / c + 2;
      } else {
        hue = (r - g) / c + 4;
      }
      hue /= 6;
      if (hue < 0) {
        hue += 1;
      }
    }
    const sat = max > 1e-6 ? c / max : 0;
    const hi = Math.min(ARC_HUE_BINS - 1, Math.floor(hue * ARC_HUE_BINS));
    const si = Math.min(ARC_SAT_BINS - 1, Math.floor(sat * ARC_SAT_BINS));
    const vi = Math.min(ARC_VAL_BINS - 1, Math.floor(max * ARC_VAL_BINS));
    hist[(hi * ARC_SAT_BINS + si) * ARC_VAL_BINS + vi] += 1;
  }
  for (let i = 0; i < hist.length; i++) {
    hist[i] /= pix;
  }
  return hist;
}

function bhattacharyya(a: Float32Array, b: Float32Array): number {
  let bc = 0;
  for (let i = 0; i < a.length; i++) {
    bc += Math.sqrt(a[i] * b[i]);
  }
  return 1 - Math.min(1, bc);
}

function madFloat(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let p = 0; p < a.length; p++) {
    d += Math.abs(a[p] - b[p]);
  }
  return d / a.length;
}

function madFloatWindow(
  a: Float32Array,
  b: Float32Array,
  width: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
): number {
  let d = 0;
  let count = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = y * width + x;
      d += Math.abs(a[i] - b[i]);
      count += 1;
    }
  }
  return count > 0 ? d / count : 0;
}

function hsvHistogramWindow(
  frame: Float32Array,
  width: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
): Float32Array {
  const hist = new Float32Array(ARC_HUE_BINS * ARC_SAT_BINS * ARC_VAL_BINS);
  let count = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const p = y * width + x;
      const r = frame[p * 3] / 255;
      const g = frame[p * 3 + 1] / 255;
      const b = frame[p * 3 + 2] / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const c = max - min;
      let hue = 0;
      if (c > 1e-6) {
        if (max === r) {
          hue = ((g - b) / c) % 6;
        } else if (max === g) {
          hue = (b - r) / c + 2;
        } else {
          hue = (r - g) / c + 4;
        }
        hue /= 6;
        if (hue < 0) {
          hue += 1;
        }
      }
      const sat = max > 1e-6 ? c / max : 0;
      const hi = Math.min(ARC_HUE_BINS - 1, Math.floor(hue * ARC_HUE_BINS));
      const si = Math.min(ARC_SAT_BINS - 1, Math.floor(sat * ARC_SAT_BINS));
      const vi = Math.min(ARC_VAL_BINS - 1, Math.floor(max * ARC_VAL_BINS));
      hist[(hi * ARC_SAT_BINS + si) * ARC_VAL_BINS + vi] += 1;
      count += 1;
    }
  }
  if (count > 0) {
    for (let i = 0; i < hist.length; i++) {
      hist[i] /= count;
    }
  }
  return hist;
}

function bestSubWindowChange(
  lumaA: Float32Array,
  lumaB: Float32Array,
  edgeA: Float32Array,
  edgeB: Float32Array,
  frameA: Float32Array,
  frameB: Float32Array,
  width: number,
  height: number,
): number {
  const w = Math.max(1, Math.min(width, Math.round(width / ARC_WINDOW_DIV)));
  const h = Math.max(1, Math.min(height, Math.round(height / ARC_WINDOW_DIV)));
  const stride = Math.max(1, Math.round(Math.min(w, h) / ARC_WINDOW_STRIDE_DIV));
  let best = 0;
  for (let y0 = 0; y0 + h <= height; y0 += stride) {
    for (let x0 = 0; x0 + w <= width; x0 += stride) {
      const grayMad = madFloatWindow(lumaA, lumaB, width, x0, y0, w, h);
      const edgeMad = madFloatWindow(edgeA, edgeB, width, x0, y0, w, h);
      const colorDist = bhattacharyya(
        hsvHistogramWindow(frameA, width, x0, y0, w, h),
        hsvHistogramWindow(frameB, width, x0, y0, w, h),
      );
      const combined = grayMad + edgeMad + ARC_COLOR_WEIGHT * colorDist;
      if (combined > best) {
        best = combined;
      }
    }
  }
  return best;
}

export type ArcInput = {
  rgb: RgbFrames;
  fps: number;
  intent: RenderIntent | null;

  beatPullPass?: boolean;
  flashPass?: boolean;
};

export function scoreArc(input: ArcInput): ArcResult {
  const { rgb, fps, intent, beatPullPass, flashPass } = input;
  const { width, height, frames } = rgb;
  const n = frames.length;

  const anchorPcts = [...ARC_ANCHOR_PCTS];
  if (n < ARC_MIN_FRAMES) {
    return {
      anchorFrames: [],
      anchorPcts,
      bestWindowChange: 0,
      dead: false,
      deterministic: true,
      floor: ARC_FLOOR,
      hard: true,
      inconclusive: "tooShort",
      intentArc: null,
      minSegmentChange: 0,
      regionFloor: ARC_REGION_FLOOR,
      segments: [],
      verdict: "inconclusive",
      wholeClipChange: 0,
    };
  }

  const anchorFrames = anchorPcts.map((p) => Math.min(n - 1, Math.max(0, Math.round(p * (n - 1)))));
  const luma = anchorFrames.map((idx) => arcLumaPlane(frames[idx], width, height));
  const edges = luma.map((plane) => sobelMap(plane, width, height));
  const hists = anchorFrames.map((idx) => hsvHistogram(frames[idx], width, height));

  const segments: ArcSegmentChange[] = [];
  for (let k = 0; k < anchorFrames.length - 1; k++) {
    const grayMad = madFloat(luma[k], luma[k + 1]);
    const edgeMad = madFloat(edges[k], edges[k + 1]);
    const colorDist = bhattacharyya(hists[k], hists[k + 1]);
    segments.push({
      colorDist,
      combined: grayMad + edgeMad + ARC_COLOR_WEIGHT * colorDist,
      edgeMad,
      grayMad,
    });
  }

  const combinedList = segments.map((s) => s.combined);
  const wholeClipChange = mean(combinedList);
  const minSegmentChange = Math.min(...combinedList);

  let bestWindowChange = 0;
  for (let k = 0; k < anchorFrames.length - 1; k++) {
    const w = bestSubWindowChange(
      luma[k],
      luma[k + 1],
      edges[k],
      edges[k + 1],
      frames[anchorFrames[k]],
      frames[anchorFrames[k + 1]],
      width,
      height,
    );
    if (w > bestWindowChange) {
      bestWindowChange = w;
    }
  }

  const evolving = wholeClipChange >= ARC_FLOOR || bestWindowChange >= ARC_REGION_FLOOR;

  const presenceQuiet =
    !evolving &&
    beatPullPass === true &&
    flashPass === true &&
    bestWindowChange >= ARC_PRESENCE_STRIKING;

  const dead = !evolving && !presenceQuiet;

  let intentArc: ArcIntentCheck | null = null;
  if (intent && intent.dropMs > 0) {
    const durationMs = (n / Math.max(1, fps)) * 1000;
    const dropPct = durationMs > 0 ? intent.dropMs / durationMs : 0;
    let dropSegment = 0;
    for (let k = 0; k < anchorPcts.length - 1; k++) {
      if (dropPct >= anchorPcts[k] && dropPct <= anchorPcts[k + 1]) {
        dropSegment = k;
        break;
      }
      if (dropPct > anchorPcts[anchorPcts.length - 1]) {
        dropSegment = segments.length - 1;
      }
    }
    const dropSegmentChange = segments[dropSegment]?.combined ?? 0;
    intentArc = {
      declared: true,
      dropMs: intent.dropMs,
      dropSegment,
      dropSegmentChange,
      meetsArc: dropSegmentChange >= wholeClipChange,
    };
  }

  return {
    anchorFrames,
    anchorPcts,
    bestWindowChange,
    dead,
    deterministic: true,
    floor: ARC_FLOOR,
    hard: true,
    ...(presenceQuiet ? { inconclusive: "presenceQuiet" } : {}),
    intentArc,
    minSegmentChange,
    regionFloor: ARC_REGION_FLOOR,
    segments,
    verdict: presenceQuiet ? "inconclusive" : dead ? "dead" : "evolving",
    wholeClipChange,
  };
}

const SEAM_SAMPLES = 16;
const SEAM_MIN_FRAMES = 3;
const SEAM_SPIKE_RATIO = 3;
const SEAM_ABS_FLOOR = 6;
const SEAM_NEIGHBORHOOD = 4;
const SEAM_POS_TOL = 2;
const SEAM_BAND_MARGIN = 0.18;

export type SeamAxis = "row" | "column";

export type Seam = {
  axis: SeamAxis;

  positionPct: number;

  frames: number;

  ratio: number;
};

export type SeamResult = {
  deterministic: true;
  hard: false;
  detected: boolean;

  seam: Seam | null;
  sampledFrames: number;
};

function seamLuma(frame: Float32Array, width: number, height: number): Float32Array {
  const pix = width * height;
  const out = new Float32Array(pix);
  for (let p = 0; p < pix; p++) {
    out[p] = 0.299 * frame[p * 3] + 0.587 * frame[p * 3 + 1] + 0.114 * frame[p * 3 + 2];
  }
  return out;
}

function rowDiffs(luma: Float32Array, width: number, height: number): number[] {
  const out: number[] = [];
  for (let r = 0; r < height - 1; r++) {
    let d = 0;
    for (let x = 0; x < width; x++) {
      d += Math.abs(luma[r * width + x] - luma[(r + 1) * width + x]);
    }
    out.push(d / width);
  }
  return out;
}

function colDiffs(luma: Float32Array, width: number, height: number): number[] {
  const out: number[] = [];
  for (let c = 0; c < width - 1; c++) {
    let d = 0;
    for (let y = 0; y < height; y++) {
      d += Math.abs(luma[y * width + c] - luma[y * width + c + 1]);
    }
    out.push(d / height);
  }
  return out;
}

type SeamHit = { frame: number; index: number; ratio: number };

function bandSpikes(diffs: number[], frame: number, extent: number): SeamHit[] {
  const out: SeamHit[] = [];
  for (let i = 0; i < diffs.length; i++) {
    const pct = (i + 0.5) / extent;
    if (pct < SEAM_BAND_MARGIN || pct > 1 - SEAM_BAND_MARGIN) {
      continue;
    }
    const here = diffs[i];
    if (here < SEAM_ABS_FLOOR) {
      continue;
    }

    if (i > 0 && diffs[i - 1] > here) {
      continue;
    }
    if (i < diffs.length - 1 && diffs[i + 1] > here) {
      continue;
    }
    const neighbours: number[] = [];
    for (let d = -SEAM_NEIGHBORHOOD; d <= SEAM_NEIGHBORHOOD; d++) {
      if (d === 0) {
        continue;
      }
      const j = i + d;
      if (j >= 0 && j < diffs.length) {
        neighbours.push(diffs[j]);
      }
    }
    if (neighbours.length === 0) {
      continue;
    }

    const base = Math.max(median(neighbours), 1);
    const ratio = here / base;
    if (ratio >= SEAM_SPIKE_RATIO) {
      out.push({ frame, index: i, ratio });
    }
  }
  return out;
}

function clusterSeam(hits: SeamHit[], axis: SeamAxis, extent: number): Seam | null {
  if (hits.length < SEAM_MIN_FRAMES) {
    return null;
  }
  let best: Seam | null = null;
  for (const anchor of hits) {
    const cluster = hits.filter((h) => Math.abs(h.index - anchor.index) <= SEAM_POS_TOL);

    const perFrame = new Map<number, SeamHit>();
    for (const hit of cluster) {
      const prev = perFrame.get(hit.frame);
      if (!prev || hit.ratio > prev.ratio) {
        perFrame.set(hit.frame, hit);
      }
    }
    if (perFrame.size < SEAM_MIN_FRAMES) {
      continue;
    }
    const reps = [...perFrame.values()];
    const ratio = median(reps.map((c) => c.ratio));
    const positionPct = (median(reps.map((c) => c.index)) + 0.5) / extent;
    if (
      best === null ||
      perFrame.size > best.frames ||
      (perFrame.size === best.frames && ratio > best.ratio)
    ) {
      best = { axis, frames: perFrame.size, positionPct, ratio };
    }
  }
  return best;
}

export function scoreSeam(rgb: RgbFrames): SeamResult {
  const { width, height, frames } = rgb;
  const n = frames.length;

  const sampleCount = Math.min(SEAM_SAMPLES, n);
  const sampled = new Set<number>();
  for (let k = 0; k < sampleCount; k++) {
    const idx = sampleCount <= 1 ? 0 : Math.round((k / (sampleCount - 1)) * (n - 1));
    sampled.add(idx);
  }
  const sampledFrames = sampled.size;

  const rowHits: SeamHit[] = [];
  const colHits: SeamHit[] = [];
  for (const fi of sampled) {
    const luma = seamLuma(frames[fi], width, height);
    if (height >= 2) {
      rowHits.push(...bandSpikes(rowDiffs(luma, width, height), fi, height));
    }
    if (width >= 2) {
      colHits.push(...bandSpikes(colDiffs(luma, width, height), fi, width));
    }
  }

  const candidates = [clusterSeam(rowHits, "row", height), clusterSeam(colHits, "column", width)]
    .filter((s): s is Seam => s !== null)
    .sort((a, b) => b.frames - a.frames || b.ratio - a.ratio);
  const seam = candidates[0] ?? null;

  return {
    detected: seam !== null,
    deterministic: true,
    hard: false,
    sampledFrames,
    seam,
  };
}

export type GateRollup = {
  hardPass: boolean;
  blockingFailures: string[];
  advisories: string[];
};

export type MotionReport = {
  trackId: string;

  allowFlash: boolean;
  logId: string | null;
  video: string;
  fps: number;
  probedFps: number;
  frames: number;
  durationMs: number;
  unreliable: boolean;
  flashSafety: FlashSafetyResult;
  beatPull: BeatPullResult & { deterministic: true; hard: true };
  arc: ArcResult;
  seam: SeamResult;
  coupling: CouplingResult | null;
  beatReactivity: BeatReactivity | null;
  intent: IntentCheckResult | null;
  intentDeclaredBand: IntentBand | null;
  gate: GateRollup;
};

export type AnalyzeMotionOptions = {
  intentPath?: string;
  allowFlash?: boolean;
};

const OUT_DIR = path.resolve(import.meta.dirname, "..", "..", "out");

function resolveVideo(target: string): string {
  if (target.endsWith(".mp4")) {
    return target;
  }
  return path.join(OUT_DIR, `${target}.mp4`);
}

function deriveTrackId(target: string, video: string): string {
  if (target.endsWith(".mp4")) {
    return path.basename(video).replace(/\.mp4$/, "");
  }
  return target;
}

function rollupFlashSafety(
  flashSafety: FlashSafetyResult,
  allowFlash: boolean,
  blockingFailures: string[],
  advisories: string[],
): void {
  if (flashSafety.unsafe && !allowFlash) {
    blockingFailures.push("flashSafety");
  } else if (flashSafety.unsafe) {
    advisories.push("flashSafety.overridden(--allow-flash)");
  }
  if (flashSafety.aaaStricterFlag) {
    advisories.push("flashSafety.aaaStricterFlag");
  }
}

function rollupMotionGate(input: {
  allowFlash: boolean;
  arc: ArcResult;
  beatPull: BeatPullResult;
  beatReactivity: BeatReactivity | null;
  coupling: CouplingResult | null;
  flashSafety: FlashSafetyResult;
  intentCheck: IntentCheckResult | null;
  probedFps: number;
  seam: SeamResult;
  unreliable: boolean;
}): GateRollup {
  const blockingFailures: string[] = [];
  const advisories: string[] = [];

  rollupFlashSafety(input.flashSafety, input.allowFlash, blockingFailures, advisories);
  if (input.beatPull.beatLocked) {
    blockingFailures.push("beatPull");
  } else if (input.beatPull.inconclusive) {
    advisories.push(`beatPull.inconclusive(${input.beatPull.inconclusive})`);
  }
  if (input.arc.dead) {
    blockingFailures.push("arc.dead");
  } else if (input.arc.verdict === "inconclusive") {
    advisories.push(
      input.arc.inconclusive === "presenceQuiet"
        ? "arc.inconclusive(presenceQuiet — eyeball the reveal)"
        : `arc.inconclusive(${input.arc.inconclusive ?? "tooShort"})`,
    );
  }
  if (input.arc.intentArc && !input.arc.intentArc.meetsArc) {
    advisories.push(`arc.intentMismatch(seg${input.arc.intentArc.dropSegment})`);
  }

  if (input.seam.detected && input.seam.seam) {
    const seam = input.seam.seam;
    const position = `${seam.axis === "row" ? "y" : "x"}≈${Math.round(seam.positionPct * 100)}%`;
    advisories.push(`seam.possible(${position})`);
  }
  if (input.coupling) {
    if (input.coupling.verdict === "dead") {
      advisories.push("coupling.dead");
    } else if (input.coupling.verdict === "weak") {
      advisories.push("coupling.weak");
    }
    for (const deadZone of input.coupling.deadZones) {
      advisories.push(
        `deadZone@${deadZone.startMs}${deadZone.overlapsDrop ? "(overlapsDrop)" : ""}`,
      );
    }
    if (input.coupling.attribution.attributedLayer !== null) {
      advisories.push(`attribution.layer${input.coupling.attribution.attributedLayer}`);
    }
  }
  if (input.beatReactivity) {
    if (input.beatReactivity.verdict === "dead") {
      advisories.push("beatReactivity.dead");
    } else if (input.beatReactivity.verdict === "weak") {
      advisories.push("beatReactivity.weak");
    }
    if (input.beatReactivity.arcScore >= 0.15) {
      advisories.push(`sceneArc(${input.beatReactivity.arcScore})`);
    }
  }
  if (input.intentCheck) {
    if (!input.intentCheck.translationTripwire.pass) {
      advisories.push("intent.translationTripwire");
    }
    if (!input.intentCheck.axisCoverage.pass) {
      advisories.push("intent.axisCoverage");
    }
    if (!input.intentCheck.drop.pass) {
      advisories.push("intent.dropMissing");
    }
    if (input.intentCheck.arcPeakAlignmentMs > 1500) {
      advisories.push(`intent.arcMisaligned(${input.intentCheck.arcPeakAlignmentMs}ms)`);
    }
  }
  if (input.unreliable) {
    advisories.push(`unreliable.fps(${input.probedFps.toFixed(2)})`);
  }

  return { advisories, blockingFailures, hardPass: blockingFailures.length === 0 };
}

export function analyzeMotion(target: string, options: AnalyzeMotionOptions = {}): MotionReport {
  const video = resolveVideo(target);
  const trackId = deriveTrackId(target, video);

  const gray = extractGrayFrames(video, { height: GATE_H, probeFps: true, width: GATE_W });
  const probedFps = gray.fps;

  const unreliable = Math.abs(probedFps - 30) > 0.5;
  const reportFps = probedFps;

  const beatPullRaw = scoreBeatPull(gray.frames);
  const beatPull = { ...beatPullRaw, deterministic: true as const, hard: true as const };

  const delta = structuralDelta(gray.frames, { smoothFrames: 1 });

  const rgb = extractRgbFrames(video, { height: FLASH_H, probeFps: true, width: FLASH_W });
  const flashSafety = scoreFlashSafety(rgb);

  const intentFile = options.intentPath ?? path.join(OUT_DIR, `${trackId}.intent.json`);
  let intent: RenderIntent | null = null;
  if (existsSync(intentFile)) {
    try {
      const parsed = JSON.parse(readFileSync(intentFile, "utf8"));
      intent = validateRenderIntent(parsed);
      if (intent === null) {
        console.warn(
          `! intent: ${intentFile} is present but FAILED validation (schema/shape mismatch) — running WITHOUT intent checks. Re-run \`validate:intent ${intentFile}\` for per-field errors.`,
        );
      }
    } catch (err) {
      console.warn(
        `! intent: ${intentFile} is present but could not be parsed — running WITHOUT intent checks. Parse error: ${err instanceof Error ? err.message : String(err)}`,
      );
      intent = null;
    }
  }

  const propsFile = path.join(OUT_DIR, `${trackId}.props.json`);
  let audio: CosmosAudio | null = null;
  let logId: string | null = intent?.logId ?? null;
  if (existsSync(propsFile)) {
    try {
      const props = JSON.parse(readFileSync(propsFile, "utf8")) as {
        audio?: CosmosAudio;
        track?: { logId?: string };
      };
      audio = props.audio ?? null;
      logId = logId ?? props.track?.logId ?? null;
    } catch {
      audio = null;
    }
  }

  const durationMs =
    audio?.durationMs ?? Math.round((gray.frames.length / Math.max(1, reportFps)) * 1000);

  const perFrame = decodeFlashFrames(rgb);

  const arc = scoreArc({
    beatPullPass: !beatPull.beatLocked,
    flashPass: !flashSafety.unsafe,
    fps: reportFps,
    intent,
    rgb,
  });

  const seam = scoreSeam(rgb);

  let coupling: CouplingResult | null = null;
  let beatReactivity: BeatReactivity | null = null;
  if (audio) {
    coupling = scoreCoupling({
      audio,
      delta,
      fps: reportFps,
      intent,
    });
    beatReactivity = scoreBeatReactivity({
      audio,
      delta,
      fps: reportFps,
      intent,
      meanL: perFrame.meanL,
    });
  }

  let intentCheck: IntentCheckResult | null = null;
  if (intent && audio) {
    intentCheck = checkIntent({ audio, delta, fps: reportFps, intent, meanL: perFrame.meanL });
  }

  const gate = rollupMotionGate({
    allowFlash: options.allowFlash === true,
    arc,
    beatPull,
    beatReactivity,
    coupling,
    flashSafety,
    intentCheck,
    probedFps,
    seam,
    unreliable,
  });

  return {
    allowFlash: options.allowFlash === true,
    arc,
    beatPull,
    beatReactivity,
    coupling,
    durationMs,
    flashSafety,
    fps: reportFps,
    frames: gray.frames.length,
    gate,
    intent: intentCheck,
    intentDeclaredBand: coupling?.intentDeclaredBand ?? null,
    logId,
    probedFps,
    seam,
    trackId,
    unreliable,
    video,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith("--"));
  const asJson = args.includes("--json");
  const allowFlash = args.includes("--allow-flash");
  const intentFlag = args.indexOf("--intent");
  const intentPath = intentFlag >= 0 ? args[intentFlag + 1] : undefined;

  if (!target) {
    console.error(
      "usage: analyze-motion <trackId|video.mp4> [--json] [--intent <file>] [--allow-flash]",
    );
    process.exit(2);
  }

  const analyzed = analyzeMotion(target, { allowFlash, intentPath });

  const report = { ...analyzed, videoSha256: sha256File(analyzed.video) };

  const reportPath = path.join(OUT_DIR, `${report.trackId}.metrics.json`);
  try {
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(
      `! could not write ${reportPath} (${error instanceof Error ? error.message : String(error)}); ship refuses without this record`,
    );
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const fl = report.flashSafety;
    console.log(
      `${fl.unsafe ? "✗" : "✓"} flash: ${fl.verdict} (general ${fl.maxGeneralFlashesPerSec}/s, red ${fl.maxRedFlashesPerSec}/s, worst area ${(fl.worstWindowArea * 100).toFixed(0)}%)`,
    );
    console.log(
      `${report.beatPull.beatLocked ? "✗" : "✓"} beat-pull: ${report.beatPull.beatLocked ? "DETECTED" : "flows"} (reversal ${report.beatPull.score.toFixed(2)})`,
    );
    const arc = report.arc;
    console.log(
      `${arc.dead ? "✗" : "✓"} arc: ${arc.verdict}${arc.inconclusive ? `(${arc.inconclusive})` : ""} (change ${arc.wholeClipChange.toFixed(3)} vs floor ${arc.floor}, best-window ${arc.bestWindowChange.toFixed(3)} vs region ${arc.regionFloor}, min-seg ${arc.minSegmentChange.toFixed(3)})${arc.intentArc ? `; drop-seg ${arc.intentArc.meetsArc ? "meets" : "MISSES"} arc` : ""}`,
    );
    if (report.seam.detected && report.seam.seam) {
      const s = report.seam.seam;
      const pos = `${s.axis === "row" ? "y" : "x"}≈${Math.round(s.positionPct * 100)}%`;
      console.log(
        `! seam: possible ${s.axis} discontinuity at ${pos} (${s.frames}/${report.seam.sampledFrames} frames, ${s.ratio.toFixed(1)}× local) — WARN only; EYEBALL it, scrub the negative-x ray for an atan branch cut (a hard horizon is legitimate)`,
      );
    }
    if (report.coupling) {
      const c = report.coupling;
      console.log(
        `~ coupling: ${c.verdict} (r=${c.coupling.toFixed(2)}, z=${c.couplingZ.toFixed(2)}, P${c.couplingPercentile.toFixed(0)}, band=${c.headlineBand}, lag=${c.lagMs}ms)${c.attribution.attributedLayer !== null ? ` [Layer ${c.attribution.attributedLayer}]` : ""}`,
      );
      if (c.deadZones.length > 0) {
        console.log(`~ ${c.deadZones.length} dead zone(s)`);
      }
    }
    if (report.intent) {
      const it = report.intent;
      console.log(
        `~ intent: drop ${it.drop.pass ? "pass" : "MISS"} (align ${it.arcPeakAlignmentMs}ms), translation ${it.translationTripwire.pass ? "ok" : "TRIPWIRE"}, coverage ${it.axisCoverage.pass ? "ok" : "GAP"}`,
      );
    }
    if (report.unreliable) {
      console.log(`! unreliable: probed fps ${report.probedFps.toFixed(2)} ≠ 30`);
    }
    if (report.gate.blockingFailures.length > 0) {
      console.error(`✗ HARD FAIL: ${report.gate.blockingFailures.join(", ")}`);
    }
  }

  process.exit(report.gate.hardPass ? 0 : 1);
}
