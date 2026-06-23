// Self-running check for the deterministic motion-metrics MATH (analyze-motion.ts)
// — no GPU, no ffmpeg, no test framework. Builds synthetic RGB frame strips +
// synthetic 20Hz curves and asserts the locked behaviours of the three scorers:
//
//   FLASH SAFETY (C2 — the HARD epilepsy gate):
//     - strobe (full-field 0.1↔0.9 >3Hz)                  → unsafe.
//     - boiling grain over a static field                 → safe (the critical
//                                                            false-positive guard).
//     - fast coherent flash buried in grain               → unsafe (the NEW RFC P0
//                                                            fixture: grain must not
//                                                            hide a real flash).
//     - localized-quadrant strobe (<25% of WHOLE frame    → unsafe (proves the
//       but ≥25% of a 10° sub-window)                        sliding-window area rule).
//     - red strobe (saturated-red alternation)            → red branch fires.
//
//   COUPLING (C3 — the anti-dead counter-gate, statistically valid):
//     - drift + a curve it tracks                         → alive.
//     - drift + FLAT curve                                → dead, attribution Layer-1.
//     - drift + DYNAMIC curve the motion ignores          → dead, attribution Layer-2.
//     - permutation-null FP rate on a NOISE fixture       → the corrected estimator
//                                                            does NOT clear "alive"
//                                                            above its defined FP rate
//                                                            (the fatal-defect guard).
//
//   INTENT (C5):
//     - drop + intent (spike in window)                   → drop.pass, small align.
//     - mis-pinned drop                                   → large arcPeakAlignmentMs.
//
// Run: `bun src/pipeline/analyze-motion.test.ts` (exits non-zero on failure).
//
// Calibration note (mirrors detect-beat-pull's discipline): the coupling
// dead/weak/alive cutoffs are derived from the per-clip permutation null
// (provisional — alive = above the 95th null percentile). Real-clip cutoffs are a
// documented follow-up over the operator-labelled set.

import assert from "node:assert/strict";

import { type CosmosAudio, type EnergySample } from "../remotion/types";

import { type RgbFrames } from "./frames";
import { type RenderIntent, RENDER_INTENT_SCHEMA } from "./intent";
import {
  checkIntent,
  scoreBeatReactivity,
  scoreCoupling,
  scoreFlashSafety,
} from "./analyze-motion";

const FPS = 30;
const FW = 64;
const FH = 114;
const PIX = FW * FH;

// ---------------------------------------------------------------------------
// Synthetic RGB frame builders (interleaved 0..255, 3 bytes/pixel)
// ---------------------------------------------------------------------------

/** A uniform full-field gray frame at 8-bit value v. */
const grayFrame = (v: number): Float32Array => {
  const f = new Float32Array(PIX * 3);
  for (let p = 0; p < PIX; p++) {
    f[p * 3] = v;
    f[p * 3 + 1] = v;
    f[p * 3 + 2] = v;
  }
  return f;
};

// Deterministic per-pixel speckle (mirrors detect-beat-pull.test.ts's hash grain).
const speckle = (x: number, t: number, amp: number): number => {
  const h = ((x * 374761393) ^ (Math.floor(t / 1.25) * 668265263)) >>> 0;
  return ((h % 1000) / 1000 - 0.5) * amp;
};

const clamp8 = (v: number): number => Math.max(0, Math.min(255, v));

/** A static field at base luma plus heavy per-pixel speckle (the grain guard). */
const grainFrame = (base: number, t: number, amp: number): Float32Array => {
  const f = new Float32Array(PIX * 3);
  for (let p = 0; p < PIX; p++) {
    const v = clamp8(base + speckle(p, t, amp));
    f[p * 3] = v;
    f[p * 3 + 1] = v;
    f[p * 3 + 2] = v;
  }
  return f;
};

/** A full-field gray flash at v, with grain on top. */
const grainFlashFrame = (v: number, t: number, amp: number): Float32Array => {
  const f = new Float32Array(PIX * 3);
  for (let p = 0; p < PIX; p++) {
    const val = clamp8(v + speckle(p, t, amp));
    f[p * 3] = val;
    f[p * 3 + 1] = val;
    f[p * 3 + 2] = val;
  }
  return f;
};

/** A frame whose TOP-LEFT quadrant strobes (value vHot) over a static dark field. */
const quadrantFrame = (vHot: number, vRest: number): Float32Array => {
  const f = new Float32Array(PIX * 3);
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      const inQuad = x < FW / 2 && y < FH / 2; // a quarter of the frame
      const v = inQuad ? vHot : vRest;
      const idx = (y * FW + x) * 3;
      f[idx] = v;
      f[idx + 1] = v;
      f[idx + 2] = v;
    }
  }
  return f;
};

/** A full-field RGB frame (for the red strobe). */
const rgbFrame = (r: number, g: number, b: number): Float32Array => {
  const f = new Float32Array(PIX * 3);
  for (let p = 0; p < PIX; p++) {
    f[p * 3] = r;
    f[p * 3 + 1] = g;
    f[p * 3 + 2] = b;
  }
  return f;
};

const wrapRgb = (frames: Float32Array[]): RgbFrames => ({
  fps: FPS,
  frames,
  height: FH,
  width: FW,
});

const FRAMES = 150; // 5s at 30fps — past the 10s-floor's structural minimums for flash rate

// gray 90 → L≈0.102, gray 243 → L≈0.896 (ΔL≈0.79, darker 0.10 < 0.80) — a real flash.
const HOT = 243;
const COLD = 90;

// ---------------------------------------------------------------------------
// FLASH FIXTURES
// ---------------------------------------------------------------------------

// STROBE: full-field 0.1↔0.9 every 3 frames (5 Hz > 3 Hz) over the WHOLE frame.
const strobe = wrapRgb(
  Array.from({ length: FRAMES }, (_, t) => grayFrame(Math.floor(t / 3) % 2 === 0 ? HOT : COLD)),
);
const strobeR = scoreFlashSafety(strobe);
assert.equal(strobeR.unsafe, true, "a full-field strobe must be UNSAFE");
assert.equal(strobeR.verdict, "unsafe", "strobe verdict unsafe");
assert.ok(strobeR.maxGeneralFlashesPerSec > 3, "strobe has >3 general flashes/sec");

// BOILING GRAIN over a static dark field: heavy per-pixel speckle, no coherent
// motion. The spatial mean barely moves → MUST be safe (the false-positive guard).
const grain = wrapRgb(Array.from({ length: FRAMES }, (_, t) => grainFrame(60, t, 80)));
const grainFlashResult = scoreFlashSafety(grain);
assert.equal(grainFlashResult.unsafe, false, "boiling grain over a static field must be SAFE");

// FAST FLASH IN GRAIN (the NEW RFC P0 fixture): a real coherent ≥0.10 full-field
// flash >3/sec BURIED in grain. Grain must NOT hide the real flash.
const fastFlashInGrain = wrapRgb(
  Array.from({ length: FRAMES }, (_, t) =>
    grainFlashFrame(Math.floor(t / 3) % 2 === 0 ? HOT : COLD, t, 40),
  ),
);
const fastFlashR = scoreFlashSafety(fastFlashInGrain);
assert.equal(fastFlashR.unsafe, true, "a real coherent flash buried in grain must be UNSAFE");

// LOCALIZED-QUADRANT STROBE: a coherent strobe over ~one quadrant (25% of the WHOLE
// frame, but ≥25% of a 10° sub-window). The whole-frame rule would MISS this; the
// sliding-window area rule must catch it.
const quadStrobe = wrapRgb(
  Array.from({ length: FRAMES }, (_, t) =>
    Math.floor(t / 3) % 2 === 0 ? quadrantFrame(HOT, 30) : quadrantFrame(COLD, 30),
  ),
);
const quadR = scoreFlashSafety(quadStrobe);
assert.equal(
  quadR.unsafe,
  true,
  "a localized quadrant strobe must be UNSAFE (sliding-window rule)",
);
assert.ok(quadR.worstWindowArea >= 0.25, "the quadrant fills ≥25% of a 10° window");

// RED STROBE: saturated red (255,0,0) ↔ dark (20,20,20) every 3 frames. The red
// branch must fire (>3 red flashes/sec, chroma change > 0.2).
const redStrobe = wrapRgb(
  Array.from({ length: FRAMES }, (_, t) =>
    Math.floor(t / 3) % 2 === 0 ? rgbFrame(255, 0, 0) : rgbFrame(20, 20, 20),
  ),
);
const redR = scoreFlashSafety(redStrobe);
assert.ok(redR.maxRedFlashesPerSec > 3, "the red branch must fire on a saturated-red strobe");
assert.equal(redR.unsafe, true, "a red strobe must be UNSAFE");

console.log(
  `flash: strobe=${strobeR.verdict} grain=${grainFlashResult.verdict} fastInGrain=${fastFlashR.verdict} quad=${quadR.verdict}(area ${(quadR.worstWindowArea * 100).toFixed(0)}%) red=${redR.verdict}(red ${redR.maxRedFlashesPerSec}/s)`,
);

// ---------------------------------------------------------------------------
// COUPLING FIXTURES — synthetic structural delta + audio curves (NO frames)
// ---------------------------------------------------------------------------

const N = 300; // 10s at 30fps — structural-delta samples
const DELTA_LEN = N;

// A 20Hz curve generator: `value(ms)` sampled every 50ms over the clip length.
const makeCurve = (durationMs: number, value: (ms: number) => number): EnergySample[] => {
  const samples: EnergySample[] = [];
  for (let ms = 0; ms <= durationMs; ms += 50) {
    samples.push({ energy: value(ms), timeMs: ms });
  }
  return samples;
};

const clipMs = (DELTA_LEN / FPS) * 1000;

// A pulsing energy curve (period ~1s) — clearly dynamic.
const pulsingCurve = makeCurve(clipMs, (ms) => 0.5 + 0.5 * Math.sin((2 * Math.PI * ms) / 1000));
// A flat curve.
const flatCurve = makeCurve(clipMs, () => 0.5);
// A loud, energetic, pulsing energy curve for dead-zone tests.
const loudPulsing = makeCurve(clipMs, (ms) => 0.7 + 0.3 * Math.sin((2 * Math.PI * ms) / 1000));

const audioFrom = (
  energy: EnergySample[],
  opts: { raw?: { bass: number; mid: number; treble: number } } = {},
): CosmosAudio => ({
  bassCurve: energy,
  beatGrid: [],
  bpm: 174,
  durationMs: clipMs,
  energyCurve: energy,
  file: "synthetic.wav",
  fluxCurve: energy,
  midCurve: energy,
  onsets: [],
  rawDynamicsHint: opts.raw,
  startMs: 0,
  trebleCurve: energy,
});

// A structural delta that TRACKS the energy curve (lagged by the EMA group delay):
// motion-change rides the curve. The energy headline lag is ~4 frames.
const trackingDelta = (curve: EnergySample[], lag: number): number[] => {
  const out: number[] = [];
  for (let f = 0; f < DELTA_LEN; f++) {
    const ms = ((f - lag) / FPS) * 1000;
    // sample the curve at the lagged time
    let v = curve[0]?.energy ?? 0;
    if (ms > 0) {
      const idx = Math.min(curve.length - 1, Math.round(ms / 50));
      v = curve[idx]?.energy ?? v;
    }
    out.push(0.01 + 0.05 * v);
  }
  return out;
};

// 1) ONE-WAY DRIFT + a curve it tracks → coupling ALIVE.
const aliveDelta = trackingDelta(pulsingCurve, 4);
const aliveCoupling = scoreCoupling({
  audio: audioFrom(pulsingCurve, { raw: { bass: 3, mid: 3, treble: 3 } }),
  delta: aliveDelta,
  fps: FPS,
  intent: null,
});
assert.equal(aliveCoupling.verdict, "alive", "drift tracking a dynamic curve must be ALIVE");
assert.ok(aliveCoupling.couplingPercentile >= 95, "alive coupling clears the 95th null percentile");
assert.equal(aliveCoupling.intentDeclaredBand, null, "no intent → intentDeclaredBand null");

// 2) DRIFT + FLAT curve → coupling DEAD, attribution Layer-1 (the track was flat).
// rawDynamicsHint low crest → "the track was flat" (signal).
const flatDelta = trackingDelta(pulsingCurve, 4); // picture moves dynamically...
const flatAudio = audioFrom(flatCurve, { raw: { bass: 1.1, mid: 1.1, treble: 1.1 } }); // ...but the curve is flat
const flatCoupling = scoreCoupling({
  audio: flatAudio,
  delta: flatDelta,
  fps: FPS,
  intent: null,
});
assert.equal(flatCoupling.verdict, "dead", "drift against a flat curve must be DEAD");
assert.equal(flatCoupling.attribution.attributedLayer, 1, "flat curve → Layer-1 attribution");

// 3) DRIFT + DYNAMIC curve the motion IGNORES → coupling DEAD, attribution Layer-2.
// A constant-velocity drift (constant delta) while the curve has big peaks; high
// raw crest so the source is dynamic → the picture ignores it (binding fault).
const constantDelta = Array.from({ length: DELTA_LEN }, () => 0.03);
// add a tiny deterministic ripple so it isn't perfectly constant (avoids degenerate variance)
for (let f = 0; f < DELTA_LEN; f++) {
  constantDelta[f] += (0.0001 * (((f * 2654435761) >>> 0) % 1000)) / 1000;
}
const ignoreCoupling = scoreCoupling({
  audio: audioFrom(pulsingCurve, { raw: { bass: 4, mid: 4, treble: 4 } }),
  delta: constantDelta,
  fps: FPS,
  intent: null,
});
assert.equal(
  ignoreCoupling.verdict,
  "dead",
  "constant drift ignoring a dynamic curve must be DEAD",
);
assert.equal(ignoreCoupling.attribution.attributedLayer, 2, "dynamic curve ignored → Layer-2");

// 4) PERMUTATION-NULL FP RATE (the fatal-defect guard). On a NOISE fixture
// (deterministic-seeded random delta vs random curve), the corrected null-based
// estimator must NOT clear "alive" — its FP rate is bounded by the chosen
// percentile (alive = above P95 → ~5% FP), where the naive max-Pearson's would be
// 21–73%. We run several independent noise pairs and assert almost none read alive.
const noiseRng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
let aliveCount = 0;
const TRIALS = 30;
for (let trial = 0; trial < TRIALS; trial++) {
  const rngD = noiseRng(1000 + trial);
  const rngC = noiseRng(50000 + trial);
  const noiseDelta = Array.from({ length: DELTA_LEN }, () => rngD());
  const noiseCurve = makeCurve(clipMs, () => rngC());
  const r = scoreCoupling({
    audio: audioFrom(noiseCurve, { raw: { bass: 2, mid: 2, treble: 2 } }),
    delta: noiseDelta,
    fps: FPS,
    intent: null,
  });
  if (r.verdict === "alive") {
    aliveCount += 1;
  }
}
const fpRate = aliveCount / TRIALS;
assert.ok(
  fpRate <= 0.2,
  `the corrected null-based estimator must bound the noise FP rate (≤20%); got ${(fpRate * 100).toFixed(0)}% over ${TRIALS} trials`,
);

console.log(
  `coupling: alive=${aliveCoupling.coupling.toFixed(2)}(P${aliveCoupling.couplingPercentile.toFixed(0)}) flat=${flatCoupling.verdict}(L${flatCoupling.attribution.attributedLayer}) ignore=${ignoreCoupling.verdict}(L${ignoreCoupling.attribution.attributedLayer}) noiseFP=${(fpRate * 100).toFixed(0)}%`,
);

// Dead-zone read: an energetic loud window with constant (uncorrelated) motion
// surfaces a dead zone.
const dzCoupling = scoreCoupling({
  audio: audioFrom(loudPulsing, { raw: { bass: 4, mid: 4, treble: 4 } }),
  delta: constantDelta,
  fps: FPS,
  intent: null,
});
assert.ok(
  dzCoupling.deadZones.length > 0,
  "energetic audio + flat motion must surface a dead zone",
);

// ---------------------------------------------------------------------------
// INTENT FIXTURES
// ---------------------------------------------------------------------------

const intentAt = (dropMs: number): RenderIntent => ({
  arcSource: "energyCurve",
  bindings: [
    { axis: "warpAmp", band: "energy", element: "filaments", intendedStrength: "strong" },
    { axis: "brightness", band: "swell", element: "glow", intendedStrength: "subtle" },
    { axis: "grain", band: "treble", element: "texture", intendedStrength: "subtle" },
  ],
  climax: { atMs: dropMs, colour: "amber", form: "bloom" },
  concept: "test",
  dropMs,
  logId: "004.9.9Z",
  motionModel: "constant-drift",
  register: "abstract",
  schema: RENDER_INTENT_SCHEMA,
  textureFamily: "nebula",
  trackId: "test",
  vehicle: "voronoi",
});

// A delta that's flat then a structural burst at t=drop (frame = dropMs/1000*fps).
const DROP_MS = 5000;
const dropFrame = Math.round((DROP_MS / 1000) * FPS);
const dropDelta = Array.from({ length: DELTA_LEN }, (_, f) => {
  const distance = Math.abs(f - dropFrame);
  return distance < 5 ? 0.2 : 0.02;
});
const meanLBurst = Array.from({ length: DELTA_LEN + 1 }, (_, f) => {
  const distance = Math.abs(f - dropFrame);
  return distance < 5 ? 0.9 : 0.3;
});

const dropAudio = audioFrom(pulsingCurve, { raw: { bass: 3, mid: 3, treble: 3 } });

const dropIntentR = checkIntent({
  audio: dropAudio,
  delta: dropDelta,
  fps: FPS,
  intent: intentAt(DROP_MS),
  meanL: meanLBurst,
});
assert.equal(dropIntentR.drop.pass, true, "a real spike at the declared drop must pass");
assert.ok(
  dropIntentR.arcPeakAlignmentMs < 500,
  `the actual peak should align with the declared drop (got ${dropIntentR.arcPeakAlignmentMs}ms)`,
);
assert.equal(dropIntentR.translationTripwire.pass, true, "no translation binding → tripwire ok");
assert.equal(dropIntentR.axisCoverage.pass, true, "structural+light+texture covered");

// MIS-PINNED drop: the burst is at 5000ms but the intent claims the drop is at
// 9000ms → drop.pass may still pass on the in-window check failing, but the
// arcPeakAlignmentMs must be large (the scripted-clock anti-pattern).
const misPinnedR = checkIntent({
  audio: dropAudio,
  delta: dropDelta,
  fps: FPS,
  intent: intentAt(9000),
  meanL: meanLBurst,
});
assert.ok(
  misPinnedR.arcPeakAlignmentMs > 1500,
  `a mis-pinned drop must flag a large arc gap (got ${misPinnedR.arcPeakAlignmentMs}ms)`,
);

// TRANSLATION TRIPWIRE: a fast band on axis "translation" is a self-reported
// beat-pull → tripwire fails.
const tripwireIntent: RenderIntent = {
  ...intentAt(DROP_MS),
  bindings: [
    { axis: "translation", band: "bassFast", element: "drift", intendedStrength: "strong" },
  ],
};
const tripwireR = checkIntent({
  audio: dropAudio,
  delta: dropDelta,
  fps: FPS,
  intent: tripwireIntent,
  meanL: meanLBurst,
});
assert.equal(
  tripwireR.translationTripwire.pass,
  false,
  "a fast band on translation must trip the tripwire",
);
assert.equal(
  tripwireR.axisCoverage.pass,
  false,
  "a single motion binding misses the coverage groups",
);

console.log(
  `intent: drop=${dropIntentR.drop.pass}(align ${dropIntentR.arcPeakAlignmentMs}ms) misPinned align=${misPinnedR.arcPeakAlignmentMs}ms tripwire=${tripwireR.translationTripwire.pass}`,
);

console.log(
  "✓ analyze-motion: flash gate catches strobe/quadrant/red/flash-in-grain & spares grain; coupling alive/dead+attribution & null-bounded FP; intent drop/tripwire/coverage",
);

// ---------------------------------------------------------------------------
// BEAT-GRID REACTIVITY + STRUCTURAL ARC (R3 rebuild — the anti-dead measure that
// works on real-beat tracks, where legacy coupling collapses).
// ---------------------------------------------------------------------------

const beatGridMs: number[] = [];
for (let ms = 0; ms < clipMs; ms += 343) {
  beatGridMs.push(ms); // ~174 BPM
}
const beatFrameSet = new Set(beatGridMs.map((ms) => Math.round((ms / 1000) * FPS)));
const beatAudio = { ...audioFrom(flatCurve), beatGrid: beatGridMs };
const flatMeanL = Array.from({ length: DELTA_LEN + 1 }, () => 0.5);

// REACTIVE: the structural delta SPIKES on the beat frames, flat between.
const reactiveDelta = Array.from({ length: DELTA_LEN }, (_, f) =>
  beatFrameSet.has(f) || beatFrameSet.has(f - 1) ? 0.25 : 0.02,
);
const reactiveR = scoreBeatReactivity({
  audio: beatAudio,
  delta: reactiveDelta,
  fps: FPS,
  intent: null,
  meanL: flatMeanL,
});
assert.ok(reactiveR.beatGridCoupling > 0.2, "on-beat spikes must give positive beat-grid coupling");
assert.ok(reactiveR.beatPercentile >= 80, "on-beat reactivity must clear the phase-shuffle null");
assert.notEqual(reactiveR.verdict, "dead", "an on-beat-reacting clip must not read dead");

// DEAD: a flat delta — no on-beat reactivity.
const deadReactDelta = Array.from({ length: DELTA_LEN }, () => 0.05);
const deadReactR = scoreBeatReactivity({
  audio: beatAudio,
  delta: deadReactDelta,
  fps: FPS,
  intent: null,
  meanL: flatMeanL,
});
assert.equal(deadReactR.verdict, "dead", "a flat delta must read dead");
assert.ok(Math.abs(deadReactR.beatGridCoupling) < 0.05, "a flat delta has ~0 beat-grid coupling");

// ARC: more activity + brightness AFTER the drop → a positive scene-change arc.
const arcIntent: RenderIntent = {
  arcSource: "energyCurve",
  bindings: [],
  climax: { atMs: 5000, colour: "x", form: "x" },
  concept: "x",
  dropMs: 5000,
  logId: null,
  motionModel: "constant-drift",
  register: "abstract",
  schema: RENDER_INTENT_SCHEMA,
  textureFamily: "nebula",
  trackId: "x",
  vehicle: "x",
};
const arcDelta = Array.from({ length: DELTA_LEN }, (_, f) => (f < 150 ? 0.03 : 0.18));
const arcMeanL = Array.from({ length: DELTA_LEN + 1 }, (_, f) => (f < 150 ? 0.3 : 0.6));
const arcR = scoreBeatReactivity({
  audio: beatAudio,
  delta: arcDelta,
  fps: FPS,
  intent: arcIntent,
  meanL: arcMeanL,
});
assert.ok(arcR.arcScore > 0.2, "a calm->vibrant character shift must give a positive arc score");
assert.equal(arcR.dropSource, "intent", "arc uses the intent dropMs when present");

console.log(
  `beat-reactivity: reactive bgc=${reactiveR.beatGridCoupling}(P${reactiveR.beatPercentile},${reactiveR.verdict}) dead=${deadReactR.verdict}(${deadReactR.beatGridCoupling}) arc=${arcR.arcScore}`,
);
console.log(
  "✓ beat-grid reactivity: on-beat spikes read reactive, flat reads dead, calm→vibrant scores an arc",
);
