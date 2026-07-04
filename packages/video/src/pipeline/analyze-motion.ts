// The deterministic aliveness + safety metrics — the objective evaluation layer
// that measures a rendered MP4 with NO LLM (RFC: Video Aliveness §4, Unit C).
// Three blocks, one combined report `out/<trackId>.metrics.json`:
//
//   - flashSafety (C2)  HARD gate. WCAG 2.3.1 / ISO 9241-391 photosensitivity:
//                       a coherent, large-area, high-magnitude, >3/sec luminance
//                       (or saturated-red) strobe blocks ship. The area test is a
//                       SLIDING 10° sub-window, not whole-frame, so a flashing
//                       corner/quadrant/logo can't slip the gate.
//   - coupling (C3)     ADVISORY in v1. The anti-dead counter-gate to beat-pull:
//                       does the picture's structural change track the music? Read
//                       against a SINGLE principled EMA-group-delay lag, the
//                       INTENT-declared driving band only, and a per-clip
//                       PERMUTATION NULL so "alive" has a defined false-positive
//                       rate. (The naive max-over-bands-and-lags Pearson reads
//                       "alive" on pure noise ~21% of the time — invalid.)
//   - intent (C5)       ADVISORY. Checks the rendered pixels against the author's
//                       declared render-intent (drop spike, the translation
//                       tripwire, axis-group coverage, per-binding coupling).
//
// It folds in `scoreBeatPull` (the existing HARD gate) on the SAME 48×86 gray
// extraction, so one report carries BOTH hard gates from one structural pass + one
// rgb pass + one ffprobe.
//
// Determinism: no Math.random / Date.now anywhere. The permutation null uses a
// FIXED-SEED PRNG (mulberry32) so a run and its test are reproducible.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type CosmosAudio, type EnergySample } from "../remotion/types";

import { extractGrayFrames, extractRgbFrames, type RgbFrames, structuralDelta } from "./frames";
import { type BeatPullResult, scoreBeatPull } from "./detect-beat-pull";
import {
  type IntentBand,
  LIGHT_AXES,
  type RenderIntent,
  SMOOTHED_BANDS,
  STRUCTURAL_AXES,
  TEXTURE_AXES,
  validateRenderIntent,
} from "./intent";

// ---------------------------------------------------------------------------
// Grids + constants
// ---------------------------------------------------------------------------

const GATE_W = 48;
const GATE_H = 86;
const FLASH_W = 64;
const FLASH_H = 114;

// The 10° visual field on a 1080×1920 portrait ≈ 341×256 px (WCAG/ISO, standard
// screen at 22–26in). On the 64×114 flash grid that scales to ~20×15 px — the
// sliding sub-window the area rule tests "≥25% flashing" inside.
const FLASH_FIELD_W = Math.round((341 / 1080) * FLASH_W); // ~20
const FLASH_FIELD_H = Math.round((256 / 1920) * FLASH_H); // ~15
const FLASH_FIELD_STRIDE = 4; // coarse stride is fine — we take the max window

// WCAG general-flash thresholds.
const FLASH_MAGNITUDE = 0.1; // each opposing transition ≥ 0.10 of max rel-luminance
const FLASH_DARK_STATE = 0.8; // the magnitude rule only counts when the darker state < 0.80
const FLASH_DEADBAND = 0.02; // STATIC extrema deadband (5× headroom below 0.10); NOT self-calibrating
const FLASH_AREA = 0.25; // ≥25% of a 10° window must flash coherently to count
const FLASH_RATE_MAX = 3; // > 3 flashes in any 1s window is the rate violation

// Red-flash thresholds.
const RED_SATURATION = 0.8; // R/(R+G+B) ≥ 0.8 = saturated red
const RED_CHROMA_CHANGE = 0.2; // CIE-1976 u'v' chromaticity change > 0.2

// Coupling: the permutation null.
const NULL_N = 200; // ~200 deterministic shuffles
const NULL_SEED = 0x9e3779b9; // a fixed seed (golden-ratio constant) — reproducible
const NULL_BLOCK = 8; // block-shuffle block length (frames) — preserves short-range autocorr
const ALIVE_PERCENTILE = 95; // provisional: alive = above the 95th null percentile
const WEAK_PERCENTILE = 80; // provisional: weak = above the 80th null percentile

// Dead-zone window read.
const WINDOW_MS = 1000; // 1s sliding window
const DEAD_ENERGY = 0.6; // a window is "energetic" at mean E ≥ 0.6 (top ~40%)

// Fault attribution: a raw-crest split point. Below this the source band itself
// was flat (Layer-1 signal); above it with a crushed normalized curve points at
// the normalizer (Layer-1 prime flattener).
const RAW_CREST_FLAT = 1.4;
const LOW_MASS_THRESHOLD = 0.05; // "low-mass tail" = fraction of samples below 5% of curve max
const LOW_MASS_CRUSHED = 0.5; // a crushed curve has a huge low-mass tail

// ---------------------------------------------------------------------------
// mulberry32 — a fixed-seed PRNG. Deterministic: same seed → same sequence.
// Used ONLY for the permutation null so the null distribution (and the tests)
// are reproducible. Never Math.random.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Small numeric helpers (pure)
// ---------------------------------------------------------------------------

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

/** Percentile of `value` within `dist` (0..100), empirical (fraction strictly below). */
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

/** Quantile of a distribution at percentile `p` (0..100), nearest-rank. */
function quantile(dist: number[], p: number): number {
  if (dist.length === 0) {
    return 0;
  }
  const sorted = [...dist].sort((x, y) => x - y);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

// ---------------------------------------------------------------------------
// Curve resampling — 20Hz EnergySample[] → per-frame, linear interp in timeMs,
// matching the shader's sampleCurve (so the metric sees what the shader saw).
// ---------------------------------------------------------------------------

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

/** Resample a 20Hz curve to `frameCount` samples at `fps` (frame f → f/fps*1000 ms). */
function resampleToFrames(curve: EnergySample[], frameCount: number, fps: number): number[] {
  const out: number[] = [];
  for (let f = 0; f < frameCount; f++) {
    out.push(sampleCurveAt(curve, (f / fps) * 1000));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Band → EMA group delay (frames). The shader smooths the curve with a one-pole
// EMA whose group delay ≈ the smoothingFrames constant of the hook. We align the
// structural delta against the curve by THAT single principled lag — never a scan.
//   useEnergy sf=4 (~135ms@30) · useBass/useMid sf=3 (~100ms) · useTreble/useFlux
//   sf=2 (~70ms) · *Fast sf=1 (~33ms). drop/swell/hit/onset ride energy/smoothed
//   bands → energy's delay. These MUST mirror each hook's default smoothingFrames
//   (use-mid.ts is sf=3, use-treble.ts / use-flux.ts are sf=2) so the metric's lag
//   matches the shader's group delay.
// ---------------------------------------------------------------------------

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

/** The lag (frames) the structural delta trails the curve: round(sf) at the probed fps. */
function lagFramesFor(band: IntentBand): number {
  return Math.max(0, Math.round(BAND_SMOOTHING_FRAMES[band]));
}

// ---------------------------------------------------------------------------
// FLASH SAFETY (C2)
// ---------------------------------------------------------------------------

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

/** WCAG relative luminance (BT.709) from an 8-bit sRGB triple. */
function relLuminance(r: number, g: number, b: number): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** CIE-1976 u'v' from an 8-bit sRGB triple (approximate, via linear RGB→XYZ). */
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
  /** per-frame: per-pixel relative luminance */
  lum: Float32Array[];
  /** per-frame: per-pixel saturated-red boolean (1/0) */
  red: Float32Array[];
  /** per-frame: per-pixel u' */
  u: Float32Array[];
  /** per-frame: per-pixel v' */
  v: Float32Array[];
  /** per-frame spatial-mean relative luminance */
  meanL: number[];
  /** per-frame spatial-mean saturated-red fraction */
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

/** Local extrema of a series with a STATIC deadband (a swing must exceed it to register). */
function extremaWithDeadband(series: number[], deadband: number): Extremum[] {
  const n = series.length;
  if (n === 0) {
    return [];
  }
  const out: Extremum[] = [{ frame: 0, value: series[0] }];
  let lastExt = series[0];
  let dir = 0; // +1 rising, -1 falling, 0 unknown
  for (let i = 1; i < n; i++) {
    const x = series[i];
    const diff = x - lastExt;
    if (dir >= 0 && diff > deadband) {
      // still / now rising
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
      // turned over: record the peak we were tracking, start falling
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

/** Count flashes on a mean series: opposing transition pairs each ≥mag with darker state <darkLimit. */
function countFlashes(series: number[], mag: number, darkLimit: number): FlashEvent[] {
  const ext = extremaWithDeadband(series, FLASH_DEADBAND);
  const flashes: FlashEvent[] = [];
  // A flash = two consecutive opposing transitions, each qualifying.
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

/** Max flashes in any 1-second sliding window, keyed off the flashes' midpoint frame. */
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

/**
 * The 10°-field area rule (the P0 safety fix). For a peak↔valley frame pair, the
 * flash counts toward the gate only if ≥25% of the pixels inside SOME 10°-sized
 * sub-window flash coherently (|ΔL|≥0.10 AND the local darker state <0.80). Slide
 * the window across the grid; return the MAX per-window flashing fraction. A
 * whole-frame rule would miss a flashing corner/quadrant/logo.
 */
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

/**
 * The grain-only spatial-noise reference: the median per-frame spatial std of the
 * relative-luminance field, an estimate of incoherent texture INDEPENDENT of the
 * temporal flash signal. It may only LOWER, never raise, the safety floor — so it
 * is reported for transparency but does not arm the gate (the static 0.02 deadband
 * already sits 5× below WCAG's 0.10).
 */
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

/** Pure flash-safety scorer over decoded rgb frames. No ffmpeg. */
export function scoreFlashSafety(rgb: RgbFrames): FlashSafetyResult {
  const perFrame = decodeFlashFrames(rgb);
  const fps = rgb.fps;
  const { width, height, lum, meanL, meanRed } = perFrame;

  // General-flash rate, on the spatial-mean luminance series (grain cancels here).
  const generalFlashes = countFlashes(meanL, FLASH_MAGNITUDE, FLASH_DARK_STATE);

  // Area-gate each candidate flash: keep only flashes that paint ≥25% of SOME 10°
  // window. Track the worst (largest) window fraction + when it happens.
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

  // Red-flash branch: a transition to/from saturated red with u'v' chroma change
  // > 0.2, same rate + area rules. Detect on the meanRed series; area-gate via the
  // saturated-red pixel fraction inside a 10° window.
  const redCandidates = countFlashes(meanRed, FLASH_MAGNITUDE, 1.0);
  const redQualified: FlashEvent[] = [];
  for (const flash of redCandidates) {
    // chroma change across the pair (spatial-mean u'v')
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

  // The stricter AAA advisory (WCAG 2.3.2): raw flashes/sec ignoring area/magnitude
  // gate — every opposing extremum pair past the deadband.
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

// ---------------------------------------------------------------------------
// COUPLING (C3)
// ---------------------------------------------------------------------------

export type CouplingResult = {
  deterministic: true;
  hard: false;
  /** raw Pearson r of structural delta vs the headline (intent-declared) band at the principled lag. */
  coupling: number;
  /** z-score of the raw coupling against the per-clip permutation null. */
  couplingZ: number;
  /** empirical percentile of the raw coupling against the null (0..100). */
  couplingPercentile: number;
  headlineBand: IntentBand;
  /** null if no valid intent declared a structural band (defaulted to energy). */
  intentDeclaredBand: IntentBand | null;
  lagFrames: number;
  lagMs: number;
  /** diagnostics — never the headline (max-of-correlated-bands inflates). */
  diagnostics: { energy: number; bass: number; flux: number };
  pictureActivity: number;
  verdict: "alive" | "weak" | "dead";
  nullDesc: string;
  deadZones: DeadZone[];
  attribution: CouplingAttribution;
  /** provisional null-derived cutoffs (alive/weak), reported for transparency; not calibrated. */
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

/** Pearson at a single fixed lag: structural delta[f] vs curve[f - lag] (curve leads). */
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

/** Block-shuffle a series with a fixed-seed PRNG (preserves short-range autocorrelation). */
function blockShuffle(series: number[], block: number, rng: () => number): number[] {
  const blocks: number[][] = [];
  for (let i = 0; i < series.length; i += block) {
    blocks.push(series.slice(i, i + block));
  }
  // Fisher–Yates over the block order.
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

/** Pure coupling scorer over a structural delta + the audio curves + intent. No ffmpeg. */
export function scoreCoupling(input: CouplingInput): CouplingResult {
  const { delta, audio, fps, intent } = input;

  // Headline band = the intent-declared structural driver (first binding whose
  // axis is structural). If no/invalid intent, default to energy with the flag.
  let intentDeclaredBand: IntentBand | null = null;
  if (intent) {
    const structuralBinding = intent.bindings.find((bnd) => STRUCTURAL_AXES.includes(bnd.axis));
    if (structuralBinding) {
      intentDeclaredBand = structuralBinding.band;
    }
  }
  const headlineBand: IntentBand = intentDeclaredBand ?? "energy";

  // Resample the 20Hz curve to the structural-delta frame grid (linear interp,
  // matching the shader's sampleCurve) so the metric sees what the shader saw.
  const curveFull = resampleToFrames(bandCurve(audio, headlineBand), delta.length, fps);
  const lag = lagFramesFor(headlineBand);
  const lagMs = Math.round((lag / fps) * 1000);

  const coupling = laggedPearson(delta, curveFull, lag);

  // Diagnostics (energy/bass/flux) at their own principled lags — reported, never
  // the headline (taking the max of correlated bands inflates the score).
  const eCurve = resampleToFrames(audio.energyCurve, delta.length, fps);
  const bCurve = resampleToFrames(audio.bassCurve, delta.length, fps);
  const fCurve = resampleToFrames(audio.fluxCurve ?? [], delta.length, fps);
  const diagnostics = {
    bass: laggedPearson(delta, bCurve, lagFramesFor("bass")),
    energy: laggedPearson(delta, eCurve, lagFramesFor("energy")),
    flux: laggedPearson(delta, fCurve, lagFramesFor("flux")),
  };

  // Per-clip PERMUTATION NULL: block-shuffle the (resampled) headline curve with a
  // fixed-seed PRNG, re-run the IDENTICAL single-lag Pearson N times, build the
  // null distribution. coupling is reported as z-score + percentile against it, so
  // "alive" has a DEFINED false-positive rate (alive = above the 95th percentile →
  // ~5% FP). The naive max-over-bands-and-lags estimator reads alive on noise
  // ~21% of the time; this bounds it at the chosen percentile.
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
  // The verdict reads off the EMPIRICAL PERCENTILE against the null (the
  // statistically principled measure with a defined FP rate), not a raw cutoff —
  // a degenerate null (a flat driving curve → every shuffle correlates ~0, like
  // the real value) yields a 0th-percentile coupling and reads "dead", which is
  // correct (there is nothing to couple to). The cuts above are reported as the
  // provisional thresholds. A near-zero coupling can't be "alive" by definition.
  let verdict: "alive" | "weak" | "dead";
  if (coupling > 1e-6 && couplingPercentile >= ALIVE_PERCENTILE) {
    verdict = "alive";
  } else if (coupling > 1e-6 && couplingPercentile >= WEAK_PERCENTILE) {
    verdict = "weak";
  } else {
    verdict = "dead";
  }

  const pictureActivity = mean(delta);

  // Windowed read REPLACES a separate dead-zone metric: slide the same estimator
  // across 1s windows; an energetic window (mean E ≥ 0.6) with near-null coupling
  // (below the alive cut) is a dead zone. A dead zone overlapping intent.dropMs is
  // escalated to a named intent failure by the report assembler.
  const deadZones = findDeadZones(delta, eCurve, headlineBand, fps, intent, aliveCut);

  // FAULT ATTRIBUTION (advisory): gate on couplingZ. Evidence = the low-mass tail
  // (fraction of curve samples below 5% of the curve max). rawDynamicsHint splits
  // "track was flat" (Layer 1 signal) from "the normalizer flattened it" (Layer 1
  // prime flattener) from "the picture ignores a dynamic curve" (Layer 2 binding).
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
  // Alive on the corrected z-score → no attribution needed.
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

  // Raw band itself flat → Layer-1 (signal): nothing for any binding to react to.
  if (rawCrest !== null && rawCrest < RAW_CREST_FLAT) {
    return {
      attributedLayer: 1,
      lowMassTail: tail,
      rawCrest,
      reason: `low coupling (z=${couplingZ.toFixed(2)}); raw crest ${rawCrest.toFixed(2)} < ${RAW_CREST_FLAT} — the track was flat (Layer 1: signal)`,
    };
  }

  // Raw band dynamic but the normalized curve is crushed (huge low-mass tail) →
  // Layer-1 prime flattener (the normalizer ate the dynamics — a different fix).
  if (rawCrest !== null && rawCrest >= RAW_CREST_FLAT && tail >= LOW_MASS_CRUSHED) {
    return {
      attributedLayer: 1,
      lowMassTail: tail,
      rawCrest,
      reason: `low coupling (z=${couplingZ.toFixed(2)}); raw crest ${rawCrest.toFixed(2)} dynamic but normalized curve crushed (${(tail * 100).toFixed(0)}% low-mass tail) — the normalizer flattened it (Layer 1: prime flattener)`,
    };
  }

  // Dynamic curve, picture ignores it → Layer-2 (binding).
  return {
    attributedLayer: 2,
    lowMassTail: tail,
    rawCrest,
    reason: `low coupling (z=${couplingZ.toFixed(2)}); curve is dynamic (${(tail * 100).toFixed(0)}% low-mass tail${rawCrest !== null ? `, raw crest ${rawCrest.toFixed(2)}` : ""}) but the picture ignores it (Layer 2: binding)`,
  };
}

/** Fraction of curve samples below 5% of the curve max (the low-mass tail). */
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
      // energy/swell/drop/etc. have no single raw band — use the loudest band's crest.
      return Math.max(rawHint.bass, rawHint.mid, rawHint.treble);
  }
}

// ---------------------------------------------------------------------------
// INTENT-VS-ACTUAL (C5)
// ---------------------------------------------------------------------------

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

/** Pure intent-vs-actual checker. No ffmpeg. */
export function checkIntent(input: IntentCheckInput): IntentCheckResult {
  const { intent, delta, meanL, audio, fps } = input;

  // (i) Drop spike: a real luminance OR structural spike in [dropMs-500, dropMs+1000].
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
  // luminance frame-to-frame delta baseline (median |ΔmeanL|)
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
  // Actual structural peak over the WHOLE clip vs the declared drop → the
  // scripted-clock anti-pattern tell. A large gap means the arc is pinned to the
  // wrong place.
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
  // A drop "passes" if there is a clear spike (structural OR luminance) in window.
  const dropPass = dropStructural >= 2.0 || dropLuminance >= 1.5;

  // (ii) Translation tripwire: any binding axis "translation" with a band NOT in
  // SMOOTHED_BANDS is a self-reported beat-pull.
  const violations: string[] = [];
  for (const bnd of intent.bindings) {
    if (bnd.axis === "translation" && !SMOOTHED_BANDS.includes(bnd.band)) {
      violations.push(`${bnd.band}→translation (${bnd.element})`);
    }
  }

  // (iii) Axis-group coverage: ≥1 structural, ≥1 light, ≥1 texture (doctrine 9).
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

  // (iv) Per-binding band coupling + discrimination (ADVISORY, realistic floors).
  const bandList: IntentBand[] = ["energy", "bass", "mid", "treble", "flux"];
  const bindings: IntentBindingCheck[] = intent.bindings.map((bnd) => {
    const claimed = laggedPearson(
      delta,
      resampleToFrames(bandCurve(audio, bnd.band), delta.length, fps),
      lagFramesFor(bnd.band),
    );
    // discrimination: claimed band correlates ≥ the others (collinear bands → low-confidence).
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
    // Realistic floor: EMA-lagged binds rarely reach 0.8 on short clips. ~0.3 for
    // a strong bind; gate on the corrected null in the report. Here pass = a
    // modest positive Pearson at the principled lag.
    const floor = bnd.intendedStrength === "strong" ? 0.3 : 0.15;
    return {
      actualCoupling: claimed,
      axis: bnd.axis,
      band: bnd.band,
      couplingPercentile: 0, // filled by assembler against the shared null if needed
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

// ---------------------------------------------------------------------------
// Beat-grid reactivity + structural arc (R3 rebuild — the anti-dead measure that
// WORKS on real-beat tracks). The legacy `coupling` block above correlates the
// structural delta against the audio curve's VARIANCE; on a sustained beat the
// energy curve is flat-high (no variance) so it collapses to ~0 ("dead") even on
// a reacting clip, and it brightness-normalizes luminosity away (so a clip that
// reacts via brightness reads negative). This block instead asks two questions
// the operator's eye actually cares about (out/overnight/INSIGHTS.md): does the
// picture's reactivity — structure AND luminosity — SPIKE on the beat-grid times
// vs between, and does its CHARACTER shift calm->vibrant across the drop (the
// prized "reactive scene-change")? Advisory; reported beside the legacy value.
// NOTE: this measures the INTERNAL/anti-dead channel; it does NOT distinguish a
// good in-place reaction from a whole-vehicle JUMP (both spike on the beat) —
// beat-pull (reversal) is the gate that catches the jump.
// ---------------------------------------------------------------------------

export type BeatReactivity = {
  deterministic: true;
  hard: false;
  /** On-beat minus off-beat reactivity, normalized to [-1,1], on a combined
   *  structural+luminance delta. >0 = the picture reacts more ON the beats. */
  beatGridCoupling: number;
  structuralBeatContrast: number;
  luminanceBeatContrast: number;
  /** Percentile of the real on-beat reactivity vs a phase-shuffled-beat null. */
  beatPercentile: number;
  verdict: "reactive" | "weak" | "dead";
  /** Structural arc: does the character shift calm->vibrant across the drop?
   *  Positive = more active/brighter after the drop (the prized scene-change). */
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

/** Pure beat-grid reactivity + arc scorer over the structural delta + the per-frame
 *  luminance + the beat grid + intent. No ffmpeg. Advisory. */
export function scoreBeatReactivity(input: BeatReactivityInput): BeatReactivity {
  const { delta, meanL, audio, fps, intent } = input;
  const n = delta.length;

  // Luminance delta, aligned to the structural delta (both index i = frame i->i+1).
  const lumaDelta: number[] = [];
  for (let i = 0; i < n; i++) {
    lumaDelta.push(Math.abs((meanL[i + 1] ?? meanL[i] ?? 0) - (meanL[i] ?? 0)));
  }
  const structN = minMaxNorm(delta);
  const lumaN = minMaxNorm(lumaDelta);
  const combined = structN.map((s, i) => s + (lumaN[i] ?? 0));

  // Beat frames in the delta index space.
  const beatFrames = audio.beatGrid
    .map((ms) => Math.round((ms / 1000) * fps))
    .filter((f) => f >= 0 && f < n);
  const halfWin = Math.max(1, Math.round(fps * 0.06)); // ~60ms on-beat window (+ hook lag)

  const structPair = onOffBeatMean(structN, beatFrames, halfWin);
  const lumaPair = onOffBeatMean(lumaN, beatFrames, halfWin);
  const combPair = onOffBeatMean(combined, beatFrames, halfWin);
  const structuralBeatContrast = contrast(structPair.on, structPair.off);
  const luminanceBeatContrast = contrast(lumaPair.on, lumaPair.off);
  const beatGridCoupling = contrast(combPair.on, combPair.off);

  // Phase-shuffle null: shift the whole beat grid by a random frame offset, recompute
  // the on-beat mean of the combined signal. ~200 deterministic shifts (mulberry32).
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

  // Structural arc: drop frame from intent (preferred) or the energy-curve peak.
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

// ---------------------------------------------------------------------------
// ARC / DEADNESS (C4 — the structural TWIN of beat-pull). Beat-pull is the HARD
// gate on the SHORT timescale (the picture jitters back and forth on the beat);
// this is the HARD gate on the LONG timescale (the picture never reorganizes at
// all — a frozen field, a looping wallpaper, near-static bars). Neither survives
// a still critique: beat-pull is invisible in stills, and a dead clip's stills
// each look fine — the deadness only exists across the WHOLE span.
//
// Method: pick 5 anchor frames at ~5/25/50/75/95% of the clip and measure how far
// the picture STRUCTURALLY reorganizes between adjacent anchors. Each pairwise
// change combines three views, so no single laundering trick (recolor only, or
// translate a fixed pattern only) passes:
//   - grayMad   : mean-abs-diff of the downscaled+blurred luma plane (gross form).
//   - edgeMad   : mean-abs-diff of the Sobel edge-magnitude map (where the
//                 structure/contours sit — the strongest discriminator: a frozen
//                 field's edges don't move even when its colour cycles).
//   - colorDist : Bhattacharyya distance of an HSV histogram (palette evolution) —
//                 weighted LIGHTLY (ARC_COLOR_WEIGHT) so a pure recolor of a frozen
//                 field can't rescue it, but genuine colour arc still counts.
// Grain robustness reuses the file's fencing tricks: frames arrive already
// area-downscaled (frames.ts `flags=area` box-averages grain spatially), and a
// 3×3 box blur pre-smooths each anchor before the diff (grain is incoherent, so
// it cancels in both the MAD and the edge map).
//
// The headline scalar `wholeClipChange` = MEAN of the 4 adjacent combined changes:
// the average magnitude by which the picture reorganizes across the arc. HARD gate
// "dead clip": wholeClipChange < ARC_FLOOR exits non-zero like the other hard
// gates. When intent declares an arc (a drop), the arc block also folds an
// advisory actual-vs-intent read: does the declared-climax anchor segment carry at
// least the clip's own mean change (the arc actually moves where it was promised)?
//
// CALIBRATED ON REAL GROUND TRUTH (footage.social.mp4, 64×114, 3×3 blur, colorW=0.25):
//   032.0.4L (a real arc — must PASS)          wholeClipChange = 0.356
//   032.0.6R (20s near-static bars — must FAIL) wholeClipChange = 0.220
// ARC_FLOOR = 0.29 sits ~23% below the pass anchor and ~24% above the fail anchor
// (symmetric margin). 6R's frozen middle shows plainly in the edge component
// (adjacent edgeMad collapses to ~0.07 vs 4L's steady ~0.27). Re-earn the floor as
// verdicts accumulate via calibrate.ts.
// ---------------------------------------------------------------------------

export const ARC_ANCHOR_PCTS = [0.05, 0.25, 0.5, 0.75, 0.95] as const;
const ARC_COLOR_WEIGHT = 0.25;
const ARC_FLOOR = 0.29;
// The best-window (subregion) read — the presence carve-out, mirroring the flash
// gate's sliding 10° sub-window. The whole-frame MEAN is a texture-era statistic: it
// dilutes a change concentrated in PART of the frame (a distant ship crossing 15% of a
// dark sky, a ruin resolving inside one fog band) below the floor even when that
// change is dramatic. So beside `wholeClipChange` the gate also finds the strongest
// reorganizing SUBREGION and passes when EITHER clears its floor — a field that
// reorganizes as a whole (wholeClipChange ≥ ARC_FLOOR) OR a subject that
// arrives/reveals/crosses in one region (bestWindowChange ≥ ARC_REGION_FLOOR). A
// frame where nothing changes anywhere still fails both (the dead clip: its edges are
// frozen in EVERY window, so no subregion clears the regional floor even as grain
// churns). The regional floor is HIGHER than the whole-frame floor because a small
// window naturally concentrates its change and averages grain less. PROVISIONAL —
// calibrated so the frozen-bars anchor (032.0.6R, wholeClipChange ~0.220) stays DEAD
// in every window and a concentrated reveal clears it; re-earn against the first real
// presence exemplar (see calibration/verdicts.json). The window is ~1/3 of each
// dimension so a quadrant-scale subject reads without a single hot pixel dominating.
const ARC_REGION_FLOOR = 0.5;
const ARC_WINDOW_DIV = 3; // sub-window ≈ width/DIV × height/DIV
const ARC_WINDOW_STRIDE_DIV = 2; // stride ≈ window / DIV (coarse — we take the max)
const ARC_MIN_FRAMES = 10; // fewer frames → inconclusive (never a false dead-fail)
// HSV histogram bins (hue×sat×val). Coarse on purpose — the arc cares about broad
// palette drift, not fine colour, and coarse bins are grain-robust.
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
  /** intent declares an arc (dropMs > 0). */
  declared: boolean;
  dropMs: number;
  /** index of the anchor segment [k,k+1] whose time span contains the drop. */
  dropSegment: number;
  dropSegmentChange: number;
  /** the declared-climax segment carries >= the clip's mean change. */
  meetsArc: boolean;
};

export type ArcResult = {
  deterministic: true;
  hard: true;
  dead: boolean;
  verdict: "evolving" | "dead" | "inconclusive";
  /** headline: mean of the adjacent combined structural changes. */
  wholeClipChange: number;
  /** the deadest adjacent transition (a sustained-freeze tell), reported. */
  minSegmentChange: number;
  /** the strongest reorganizing SUBREGION across all adjacent pairs (the presence read). */
  bestWindowChange: number;
  floor: number;
  /** the higher floor the best-window read must clear to rescue a small whole-frame mean. */
  regionFloor: number;
  anchorPcts: number[];
  anchorFrames: number[];
  segments: ArcSegmentChange[];
  intentArc: ArcIntentCheck | null;
};

/** Downscaled+blurred luma plane (0..1) of one rgb frame. 3×3 box blur = grain fence. */
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

/** Sobel edge-magnitude map of a luma plane (borders left 0). */
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

/** Normalized HSV histogram of one rgb frame (ARC_HUE_BINS×ARC_SAT_BINS×ARC_VAL_BINS). */
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

/** Bhattacharyya distance of two normalized histograms (0 identical, 1 disjoint). */
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

/** Mean-abs-diff of two planes restricted to a [x0,y0]+[w,h] sub-window. */
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

/** Normalized HSV histogram of one rgb frame restricted to a sub-window. */
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

/**
 * The strongest reorganizing SUBREGION between two anchor frames: slide a
 * ~(width/DIV × height/DIV) window across the frame and return the MAX windowed
 * `combined` (grayMad + edgeMad + colorW·colorDist) — the same metric as the
 * whole-frame read, restricted to a region. This is how a change concentrated in
 * part of the frame (a subject arriving/crossing) survives a small whole-frame mean.
 * Mirrors `worstWindowFlashFraction`'s sliding-window design.
 */
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
};

/** Pure arc/deadness scorer over the decoded rgb frames + intent. No ffmpeg. HARD. */
export function scoreArc(input: ArcInput): ArcResult {
  const { rgb, fps, intent } = input;
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

  // The best-window (subregion) read: the strongest reorganizing region across all
  // adjacent anchor pairs. A subject that arrives/reveals/crosses in part of the
  // frame produces a large windowed change even when the whole-frame mean is small.
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

  // Dead only when NEITHER the whole frame reorganizes NOR any subregion does — a
  // field that changes as a whole passes on wholeClipChange; a subject that reveals
  // in one region passes on bestWindowChange; a frozen frame fails both.
  const dead = wholeClipChange < ARC_FLOOR && bestWindowChange < ARC_REGION_FLOOR;

  // Intent arc fold (advisory): if the intent declares a drop, locate the anchor
  // segment whose [startPct,endPct] span contains it and check its change carries
  // at least the clip mean — the promised climax actually reorganizes the picture.
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
    intentArc,
    minSegmentChange,
    regionFloor: ARC_REGION_FLOOR,
    segments,
    verdict: dead ? "dead" : "evolving",
    wholeClipChange,
  };
}

// ---------------------------------------------------------------------------
// The orchestrator + report assembly (C6)
// ---------------------------------------------------------------------------

export type GateRollup = {
  hardPass: boolean;
  blockingFailures: string[];
  advisories: string[];
};

export type MotionReport = {
  trackId: string;
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

/**
 * Run all deterministic metrics on a target (trackId or video path), fold in the
 * beat-pull gate on the SAME 48×86 extraction, and assemble the combined report.
 * One gray pass (structure) + one rgb pass (flash) + one ffprobe.
 */
export function analyzeMotion(target: string, options: AnalyzeMotionOptions = {}): MotionReport {
  const video = resolveVideo(target);
  const trackId = deriveTrackId(target, video);

  // ONE structural extraction (48×86, probed fps for timeline alignment) serves
  // beat-pull + coupling + dead-zone + intent.
  const gray = extractGrayFrames(video, { height: GATE_H, probeFps: true, width: GATE_W });
  const probedFps = gray.fps;
  // Beat-pull PINS fps=30 internally (its calibration was earned there); a probed
  // fps ≠ 30 marks the report unreliable (timeline alignment for coupling/intent
  // would mis-align).
  const unreliable = Math.abs(probedFps - 30) > 0.5;
  const reportFps = probedFps;

  const beatPullRaw = scoreBeatPull(gray.frames); // fps defaults to 30 internally
  const beatPull = { ...beatPullRaw, deterministic: true as const, hard: true as const };

  // The shared structural delta (the gate's representation: mean-subtract + fence).
  const delta = structuralDelta(gray.frames, { smoothFrames: 1 });

  // ONE rgb extraction (64×114, probed fps) for flash safety.
  const rgb = extractRgbFrames(video, { height: FLASH_H, probeFps: true, width: FLASH_W });
  const flashSafety = scoreFlashSafety(rgb);

  // Read intent + props. A PRESENT-but-invalid intent is a loud warning (a
  // silently-swallowed parse error hides a real authoring bug — the checker then
  // runs blind). A MISSING file stays warn-and-stub (v1 law): intent is optional.
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

  // The per-frame luminance series (reused by beat-reactivity + the intent check).
  const perFrame = decodeFlashFrames(rgb);

  // ARC / DEADNESS — the long-timescale HARD gate, on the same rgb extraction.
  const arc = scoreArc({ fps: reportFps, intent, rgb });

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

  // Gate roll-up. TWO HARD gates: flashSafety + beatPull. Coupling is advisory.
  const blockingFailures: string[] = [];
  const advisories: string[] = [];

  if (flashSafety.unsafe && !options.allowFlash) {
    blockingFailures.push("flashSafety");
  } else if (flashSafety.unsafe && options.allowFlash) {
    advisories.push("flashSafety.overridden(--allow-flash)");
  }
  if (flashSafety.aaaStricterFlag) {
    advisories.push("flashSafety.aaaStricterFlag");
  }
  if (beatPull.beatLocked) {
    blockingFailures.push("beatPull");
  } else if (beatPull.inconclusive) {
    // Pass-with-note: an inconclusive beat-pull never blocks (like the too-few-frames
    // case). The low-motion carve-out lands here for calm presence clips — the
    // deadness question is owned by the arc + coupling reads below.
    advisories.push(`beatPull.inconclusive(${beatPull.inconclusive})`);
  }
  if (arc.dead) {
    blockingFailures.push("arc.dead");
  } else if (arc.verdict === "inconclusive") {
    advisories.push("arc.inconclusive(tooShort)");
  }
  if (arc.intentArc && !arc.intentArc.meetsArc) {
    advisories.push(`arc.intentMismatch(seg${arc.intentArc.dropSegment})`);
  }

  if (coupling) {
    if (coupling.verdict === "dead") {
      advisories.push("coupling.dead");
    } else if (coupling.verdict === "weak") {
      advisories.push("coupling.weak");
    }
    for (const dz of coupling.deadZones) {
      advisories.push(`deadZone@${dz.startMs}${dz.overlapsDrop ? "(overlapsDrop)" : ""}`);
    }
    if (coupling.attribution.attributedLayer !== null) {
      advisories.push(`attribution.layer${coupling.attribution.attributedLayer}`);
    }
  }

  if (beatReactivity) {
    if (beatReactivity.verdict === "dead") {
      advisories.push("beatReactivity.dead");
    } else if (beatReactivity.verdict === "weak") {
      advisories.push("beatReactivity.weak");
    }
    if (beatReactivity.arcScore >= 0.15) {
      advisories.push(`sceneArc(${beatReactivity.arcScore})`);
    }
  }

  if (intentCheck) {
    if (!intentCheck.translationTripwire.pass) {
      advisories.push("intent.translationTripwire");
    }
    if (!intentCheck.axisCoverage.pass) {
      advisories.push("intent.axisCoverage");
    }
    if (!intentCheck.drop.pass) {
      advisories.push("intent.dropMissing");
    }
    if (intentCheck.arcPeakAlignmentMs > 1500) {
      advisories.push(`intent.arcMisaligned(${intentCheck.arcPeakAlignmentMs}ms)`);
    }
  }
  if (unreliable) {
    advisories.push(`unreliable.fps(${probedFps.toFixed(2)})`);
  }

  const hardPass = blockingFailures.length === 0;

  return {
    arc,
    beatPull,
    beatReactivity,
    coupling,
    durationMs,
    flashSafety,
    fps: reportFps,
    frames: gray.frames.length,
    gate: { advisories, blockingFailures, hardPass },
    intent: intentCheck,
    intentDeclaredBand: coupling?.intentDeclaredBand ?? null,
    logId,
    probedFps,
    trackId,
    unreliable,
    video,
  };
}

// ---------------------------------------------------------------------------
// CLI: bun src/pipeline/analyze-motion.ts <trackId|video> [--json] [--intent <f>] [--allow-flash]
// Exits non-zero ONLY on a HARD failure (flash unsafe without --allow-flash, or
// beat-pull beatLocked). Everything else exits 0.
// ---------------------------------------------------------------------------

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

  const report = analyzeMotion(target, { allowFlash, intentPath });

  // Persist the combined report next to the other artifacts.
  const reportPath = path.join(OUT_DIR, `${report.trackId}.metrics.json`);
  try {
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
  } catch {
    // non-fatal — the report is still printed
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
      `${arc.dead ? "✗" : "✓"} arc: ${arc.verdict} (change ${arc.wholeClipChange.toFixed(3)} vs floor ${arc.floor}, best-window ${arc.bestWindowChange.toFixed(3)} vs region ${arc.regionFloor}, min-seg ${arc.minSegmentChange.toFixed(3)})${arc.intentArc ? `; drop-seg ${arc.intentArc.meetsArc ? "meets" : "MISSES"} arc` : ""}`,
    );
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
