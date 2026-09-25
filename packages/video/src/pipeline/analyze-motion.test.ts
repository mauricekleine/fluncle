import assert from "node:assert/strict";

import { type CosmosAudio, type EnergySample } from "../remotion/types";

import { type RgbFrames } from "./frames";
import { type RenderIntent, RENDER_INTENT_SCHEMA } from "./intent";
import {
  checkIntent,
  scoreArc,
  scoreBeatReactivity,
  scoreCoupling,
  scoreFlashSafety,
  scoreSeam,
} from "./analyze-motion";

const FPS = 30;
const FW = 64;
const FH = 114;
const PIX = FW * FH;

const grayFrame = (v: number): Float32Array => {
  const f = new Float32Array(PIX * 3);
  for (let p = 0; p < PIX; p++) {
    f[p * 3] = v;
    f[p * 3 + 1] = v;
    f[p * 3 + 2] = v;
  }
  return f;
};

const speckle = (x: number, t: number, amp: number): number => {
  const h = ((x * 374761393) ^ (Math.floor(t / 1.25) * 668265263)) >>> 0;
  return ((h % 1000) / 1000 - 0.5) * amp;
};

const clamp8 = (v: number): number => Math.max(0, Math.min(255, v));

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

const quadrantFrame = (vHot: number, vRest: number): Float32Array => {
  const f = new Float32Array(PIX * 3);
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      const inQuad = x < FW / 2 && y < FH / 2;
      const v = inQuad ? vHot : vRest;
      const idx = (y * FW + x) * 3;
      f[idx] = v;
      f[idx + 1] = v;
      f[idx + 2] = v;
    }
  }
  return f;
};

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

const FRAMES = 150;

const HOT = 243;
const COLD = 90;

const strobe = wrapRgb(
  Array.from({ length: FRAMES }, (_, t) => grayFrame(Math.floor(t / 3) % 2 === 0 ? HOT : COLD)),
);
const strobeR = scoreFlashSafety(strobe);
assert.equal(strobeR.unsafe, true, "a full-field strobe must be UNSAFE");
assert.equal(strobeR.verdict, "unsafe", "strobe verdict unsafe");
assert.ok(strobeR.maxGeneralFlashesPerSec > 3, "strobe has >3 general flashes/sec");

const grain = wrapRgb(Array.from({ length: FRAMES }, (_, t) => grainFrame(60, t, 80)));
const grainFlashResult = scoreFlashSafety(grain);
assert.equal(grainFlashResult.unsafe, false, "boiling grain over a static field must be SAFE");

const fastFlashInGrain = wrapRgb(
  Array.from({ length: FRAMES }, (_, t) =>
    grainFlashFrame(Math.floor(t / 3) % 2 === 0 ? HOT : COLD, t, 40),
  ),
);
const fastFlashR = scoreFlashSafety(fastFlashInGrain);
assert.equal(fastFlashR.unsafe, true, "a real coherent flash buried in grain must be UNSAFE");

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

const N = 300;
const DELTA_LEN = N;

const makeCurve = (durationMs: number, value: (ms: number) => number): EnergySample[] => {
  const samples: EnergySample[] = [];
  for (let ms = 0; ms <= durationMs; ms += 50) {
    samples.push({ energy: value(ms), timeMs: ms });
  }
  return samples;
};

const clipMs = (DELTA_LEN / FPS) * 1000;

const pulsingCurve = makeCurve(clipMs, (ms) => 0.5 + 0.5 * Math.sin((2 * Math.PI * ms) / 1000));

const flatCurve = makeCurve(clipMs, () => 0.5);

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

const trackingDelta = (curve: EnergySample[], lag: number): number[] => {
  const out: number[] = [];
  for (let f = 0; f < DELTA_LEN; f++) {
    const ms = ((f - lag) / FPS) * 1000;

    let v = curve[0]?.energy ?? 0;
    if (ms > 0) {
      const idx = Math.min(curve.length - 1, Math.round(ms / 50));
      v = curve[idx]?.energy ?? v;
    }
    out.push(0.01 + 0.05 * v);
  }
  return out;
};

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

const flatDelta = trackingDelta(pulsingCurve, 4);
const flatAudio = audioFrom(flatCurve, { raw: { bass: 1.1, mid: 1.1, treble: 1.1 } });
const flatCoupling = scoreCoupling({
  audio: flatAudio,
  delta: flatDelta,
  fps: FPS,
  intent: null,
});
assert.equal(flatCoupling.verdict, "dead", "drift against a flat curve must be DEAD");
assert.equal(flatCoupling.attribution.attributedLayer, 1, "flat curve → Layer-1 attribution");

const constantDelta = Array.from({ length: DELTA_LEN }, () => 0.03);

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

const beatGridMs: number[] = [];
for (let ms = 0; ms < clipMs; ms += 343) {
  beatGridMs.push(ms);
}
const beatFrameSet = new Set(beatGridMs.map((ms) => Math.round((ms / 1000) * FPS)));
const beatAudio = { ...audioFrom(flatCurve), beatGrid: beatGridMs };
const flatMeanL = Array.from({ length: DELTA_LEN + 1 }, () => 0.5);

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

const ARC_FRAMES = 200;

const arcBandFrame = (t: number): Float32Array => {
  const f = new Float32Array(PIX * 3);
  const bandY = Math.floor((t / ARC_FRAMES) * FH);
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      const v = Math.abs(y - bandY) < 10 ? 220 : 40;
      const idx = (y * FW + x) * 3;
      f[idx] = v;
      f[idx + 1] = v;
      f[idx + 2] = v;
    }
  }
  return f;
};
const arcEvolving = wrapRgb(Array.from({ length: ARC_FRAMES }, (_, t) => arcBandFrame(t)));
const evolvingArc = scoreArc({ fps: FPS, intent: null, rgb: arcEvolving });
assert.equal(evolvingArc.verdict, "evolving", "a sweeping structural band must read EVOLVING");
assert.equal(evolvingArc.dead, false, "an evolving clip is not dead");
assert.ok(
  evolvingArc.wholeClipChange >= evolvingArc.floor,
  `evolving change must clear the floor (got ${evolvingArc.wholeClipChange.toFixed(3)} vs ${evolvingArc.floor})`,
);

const arcStaticBars = (t: number): Float32Array => {
  const f = new Float32Array(PIX * 3);
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      const bar = Math.floor(x / 8) % 2 === 0;
      const v = clamp8((bar ? 180 : 40) + speckle(y * FW + x, t, 30));
      const idx = (y * FW + x) * 3;
      f[idx] = v;
      f[idx + 1] = v;
      f[idx + 2] = v;
    }
  }
  return f;
};
const arcDeadStrip = wrapRgb(Array.from({ length: ARC_FRAMES }, (_, t) => arcStaticBars(t)));
const deadArc = scoreArc({ fps: FPS, intent: null, rgb: arcDeadStrip });
assert.equal(deadArc.dead, true, "frozen bars under grain must read DEAD (the laundering guard)");
assert.equal(deadArc.verdict, "dead", "dead verdict on a frozen structure");
assert.ok(
  deadArc.wholeClipChange < deadArc.floor,
  `dead change must sit below the floor (got ${deadArc.wholeClipChange.toFixed(3)})`,
);

assert.ok(
  deadArc.bestWindowChange < deadArc.regionFloor,
  `a frozen clip must fail the best-window read too (got ${deadArc.bestWindowChange.toFixed(3)} vs region ${deadArc.regionFloor})`,
);

const arcRevealFrame = (t: number): Float32Array => {
  const f = new Float32Array(PIX * 3);
  const prog = t / ARC_FRAMES;
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      let v = clamp8(30 + speckle(y * FW + x, t, 6));
      if (x >= 40 && y >= 70) {
        const sx = 44 + Math.floor(prog * 14);
        if (Math.abs(x - sx) < 5 && prog > 0.15) {
          v = clamp8(210 + speckle(y * FW + x, t, 6));
        }
      }
      const idx = (y * FW + x) * 3;
      f[idx] = v;
      f[idx + 1] = v;
      f[idx + 2] = v;
    }
  }
  return f;
};
const arcReveal = wrapRgb(Array.from({ length: ARC_FRAMES }, (_, t) => arcRevealFrame(t)));
const revealArc = scoreArc({ fps: FPS, intent: null, rgb: arcReveal });
assert.ok(
  revealArc.wholeClipChange < revealArc.floor,
  `the reveal's WHOLE-frame mean must sit below the floor — the change is concentrated (got ${revealArc.wholeClipChange.toFixed(3)})`,
);
assert.ok(
  revealArc.bestWindowChange >= revealArc.regionFloor,
  `a concentrated subject-reveal must clear the regional floor (got ${revealArc.bestWindowChange.toFixed(3)} vs region ${revealArc.regionFloor})`,
);
assert.equal(
  revealArc.dead,
  false,
  "a subject revealing in part of the frame must NOT read as dead (best-window rescues it)",
);
assert.equal(revealArc.verdict, "evolving", "the reveal reads evolving via the subregion read");

const arcQuietRevealFrame = (t: number): Float32Array => {
  const f = new Float32Array(PIX * 3);
  const prog = t / ARC_FRAMES;
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      let v = clamp8(30 + speckle(y * FW + x, t, 6));
      if (x >= 40 && y >= 70) {
        const sx = 44 + Math.floor(prog * 14);
        if (Math.abs(x - sx) < 4 && prog > 0.15) {
          v = clamp8(125 + speckle(y * FW + x, t, 6));
        }
      }
      const idx = (y * FW + x) * 3;
      f[idx] = v;
      f[idx + 1] = v;
      f[idx + 2] = v;
    }
  }
  return f;
};
const arcQuietReveal = wrapRgb(
  Array.from({ length: ARC_FRAMES }, (_, t) => arcQuietRevealFrame(t)),
);

const quietBare = scoreArc({ fps: FPS, intent: null, rgb: arcQuietReveal });
assert.ok(
  quietBare.wholeClipChange < quietBare.floor,
  `presence-quiet: whole-frame mean must sit below the floor (got ${quietBare.wholeClipChange.toFixed(3)})`,
);
assert.ok(
  quietBare.bestWindowChange >= 0.4 && quietBare.bestWindowChange < quietBare.regionFloor,
  `presence-quiet: region read must land in the striking band [0.4, ${quietBare.regionFloor}) (got ${quietBare.bestWindowChange.toFixed(3)})`,
);

assert.equal(
  quietBare.verdict,
  "dead",
  "presence-quiet: no gate flags → the pre-relief dead read holds",
);
assert.equal(quietBare.dead, true, "presence-quiet: bare call still hard-fails as dead");

const quietRelieved = scoreArc({
  beatPullPass: true,
  flashPass: true,
  fps: FPS,
  intent: null,
  rgb: arcQuietReveal,
});
assert.equal(
  quietRelieved.verdict,
  "inconclusive",
  "presence-quiet: both gates pass → inconclusive",
);
assert.equal(
  quietRelieved.inconclusive,
  "presenceQuiet",
  "presence-quiet: the reason is presenceQuiet",
);
assert.equal(quietRelieved.dead, false, "presence-quiet relief is an advisory PASS, never dead");

const quietOneGate = scoreArc({
  beatPullPass: true,
  flashPass: false,
  fps: FPS,
  intent: null,
  rgb: arcQuietReveal,
});
assert.equal(quietOneGate.verdict, "dead", "presence-quiet: one gate failing → no relief, dead");

const arcShort = wrapRgb(Array.from({ length: 4 }, () => grayFrame(120)));
const shortArc = scoreArc({ fps: FPS, intent: null, rgb: arcShort });
assert.equal(shortArc.verdict, "inconclusive", "too few frames → inconclusive");
assert.equal(shortArc.dead, false, "a too-short clip never hard-fails as dead");

const arcWithIntent = scoreArc({
  fps: FPS,
  intent: intentAt(Math.round(((ARC_FRAMES / 2 / FPS) * 1000) / 1) - 100),
  rgb: arcEvolving,
});
assert.ok(arcWithIntent.intentArc?.declared, "an intent with a drop declares an arc check");
assert.equal(arcWithIntent.intentArc?.meetsArc, true, "a uniform sweep meets its declared arc");

console.log(
  `arc: evolving=${evolvingArc.wholeClipChange.toFixed(3)}(${evolvingArc.verdict}) dead=${deadArc.wholeClipChange.toFixed(3)}/win${deadArc.bestWindowChange.toFixed(3)}(${deadArc.verdict}) reveal=${revealArc.wholeClipChange.toFixed(3)}/win${revealArc.bestWindowChange.toFixed(3)}(${revealArc.verdict}) short=${shortArc.verdict} intentArc.meets=${arcWithIntent.intentArc?.meetsArc}`,
);
console.log(
  "✓ arc/deadness: a sweeping structure reads evolving, frozen bars under grain read DEAD (laundering guard), a concentrated subject-reveal is rescued by the best-window read, short is inconclusive, intent arc folds",
);

const SEAM_FRAMES = 40;
const SEAM_ROW = 57;
const SEAM_COL = 22;

const seamRowFrame = (t: number): Float32Array => {
  const f = new Float32Array(PIX * 3);
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      const base = 40 + (y / FH) * 40;
      const jump = y > SEAM_ROW ? 120 : 0;
      const v = clamp8(base + jump + speckle(y * FW + x, t, 8));
      const p = (y * FW + x) * 3;
      f[p] = v;
      f[p + 1] = v;
      f[p + 2] = v;
    }
  }
  return f;
};

const seamHalfRowFrame = (t: number): Float32Array => {
  const f = new Float32Array(PIX * 3);
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      const base = 40 + (y / FH) * 40;
      const jump = y > SEAM_ROW && x < FW / 2 ? 120 : 0;
      const v = clamp8(base + jump + speckle(y * FW + x, t, 8));
      const p = (y * FW + x) * 3;
      f[p] = v;
      f[p + 1] = v;
      f[p + 2] = v;
    }
  }
  return f;
};

const seamColFrame = (t: number): Float32Array => {
  const f = new Float32Array(PIX * 3);
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      const base = 40 + (x / FW) * 40;
      const jump = x > SEAM_COL ? 120 : 0;
      const v = clamp8(base + jump + speckle(y * FW + x, t, 8));
      const p = (y * FW + x) * 3;
      f[p] = v;
      f[p + 1] = v;
      f[p + 2] = v;
    }
  }
  return f;
};

const cleanFrame = (t: number): Float32Array => {
  const f = new Float32Array(PIX * 3);
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      const v = clamp8(
        70 +
          40 * Math.sin((x / FW) * Math.PI) * Math.cos((y / FH) * Math.PI) +
          speckle(y * FW + x, t, 26),
      );
      const p = (y * FW + x) * 3;
      f[p] = v;
      f[p + 1] = v;
      f[p + 2] = v;
    }
  }
  return f;
};

const seamRow = scoreSeam(wrapRgb(Array.from({ length: SEAM_FRAMES }, (_, t) => seamRowFrame(t))));
assert.equal(seamRow.detected, true, "a hard horizontal discontinuity must be detected as a seam");
assert.equal(seamRow.seam?.axis, "row", "a horizontal seam is a ROW-axis discontinuity");
assert.ok(
  seamRow.seam !== null && Math.abs(seamRow.seam.positionPct - SEAM_ROW / FH) < 0.05,
  `the seam position must sit at the discontinuity (~${((SEAM_ROW / FH) * 100).toFixed(0)}%, got ${((seamRow.seam?.positionPct ?? 0) * 100).toFixed(0)}%)`,
);
assert.ok(
  (seamRow.seam?.frames ?? 0) >= SEAM_FRAMES / 4,
  "a baked-in seam persists across (nearly) every sampled frame",
);

const seamHalf = scoreSeam(
  wrapRgb(Array.from({ length: SEAM_FRAMES }, (_, t) => seamHalfRowFrame(t))),
);
assert.equal(
  seamHalf.detected,
  true,
  "a half-width negative-x-ray seam (left half only) must still be detected",
);
assert.equal(
  seamHalf.seam?.axis,
  "row",
  "the half-width negative-x-ray seam is a row discontinuity",
);

const seamCol = scoreSeam(wrapRgb(Array.from({ length: SEAM_FRAMES }, (_, t) => seamColFrame(t))));
assert.equal(seamCol.detected, true, "a hard vertical discontinuity must be detected as a seam");
assert.equal(seamCol.seam?.axis, "column", "a vertical seam is a COLUMN-axis discontinuity");
assert.ok(
  seamCol.seam !== null && Math.abs(seamCol.seam.positionPct - SEAM_COL / FW) < 0.06,
  `the column seam must sit at the discontinuity (~${((SEAM_COL / FW) * 100).toFixed(0)}%, got ${((seamCol.seam?.positionPct ?? 0) * 100).toFixed(0)}%)`,
);

const clean = scoreSeam(wrapRgb(Array.from({ length: SEAM_FRAMES }, (_, t) => cleanFrame(t))));
assert.equal(
  clean.detected,
  false,
  "a smooth field with no discontinuity must NOT warn (grain guard)",
);
assert.equal(clean.seam, null, "a clean field reports no seam");

const transient = scoreSeam(
  wrapRgb(Array.from({ length: SEAM_FRAMES }, (_, t) => (t < 2 ? seamRowFrame(t) : cleanFrame(t)))),
);
assert.equal(
  transient.detected,
  false,
  "a 2-frame transient must NOT trip the seam warn (persistence ≥3 sampled frames)",
);

console.log(
  `seam: full=${seamRow.detected}@${((seamRow.seam?.positionPct ?? 0) * 100).toFixed(0)}%(${seamRow.seam?.frames}/${seamRow.sampledFrames}) half=${seamHalf.detected} col=${seamCol.detected}@${((seamCol.seam?.positionPct ?? 0) * 100).toFixed(0)}% clean=${clean.detected} transient=${transient.detected}`,
);
console.log(
  "✓ spatial seam: a hard row/column discontinuity (incl. a half-width negative-x-ray cut) warns at the right position, a smooth grained field does NOT, and a 2-frame transient never trips the persistence guard",
);
