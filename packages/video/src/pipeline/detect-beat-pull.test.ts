// Self-running check for the beat-pull scorer's MATH — no GPU, no ffmpeg, no test
// framework. Builds synthetic frame sequences (a 1-D gray strip with a moving bump)
// and asserts the hardened scorer's three locked behaviours:
//   - DRIFT  : the bump glides → low reversal → passes.
//   - JITTER : the bump oscillates back and forth → high reversal, survives the
//              temporal smooth → fails.
//   - GRAIN  : a glide buried in per-frame speckle reads as snap-back WITHOUT the
//              fence (raw fails), and the temporal smooth removes a large chunk of
//              it. (The synthetic grain is harsher than real grain, which the gate's
//              48px spatial downscale also averages — so on real footage the fence
//              clears it fully; see the calibration note below.)
// Run: `bun src/pipeline/detect-beat-pull.test.ts` (exits non-zero on failure).
//
// Threshold calibration (real rendered clips, GRAIN-HARDENED reversal — 3-frame
// temporal pre-smooth, the default):
//   clean cluster  004.4.3L 0.10 · 004.7.2I 0.09          (operator-confirmed clean)
//   motion pulls   004.6.0K 0.24 · 004.6.0Q 0.28 · 004.9.2Q 0.34  (operator-confirmed)
//   the false fix  004.6.0K with only its grain clock slowed → 0.21 → still FAILS
// Without the fence those same clips score ~0.20 (clean) to ~0.42-0.57 (pulls), but
// ~40% of a pull's raw score is film-grain flicker, not motion — so a grain-only
// tweak "passes" the raw gate while the motion pull remains. The fence fixes that;
// threshold 0.17 splits clean (~0.10) from real motion pulls (0.24+).

import assert from "node:assert/strict";

import { scoreBeatPull } from "./detect-beat-pull";

const N = 64; // pixels across the strip
const FRAMES = 300;
const SIGMA = 6;

const bump = (pos: number, x: number): number =>
  200 * Math.exp(-((x - pos) ** 2) / (2 * SIGMA * SIGMA));

// Per-pixel speckle reseeded every ~1.25 frames, matching GLSL.filmGrain's
// floor(time*24) at 30fps. Deterministic (hash of pixel + reseeded frame).
const speckle = (x: number, t: number, amp: number): number => {
  const h = ((x * 374761393) ^ (Math.floor(t / 1.25) * 668265263)) >>> 0;
  return ((h % 1000) / 1000 - 0.5) * amp;
};

const strip = (pos: number, t: number, grain: number): Float32Array => {
  const f = new Float32Array(N);
  for (let x = 0; x < N; x++) {
    f[x] = 30 + bump(pos, x) + (grain ? speckle(x, t, grain) : 0);
  }
  return f;
};

// DRIFT: a smooth glide across the strip. Directed motion, no grain.
const drift = Array.from({ length: FRAMES }, (_, t) => strip(12 + (40 * t) / FRAMES, t, 0));
// JITTER: the bump oscillates back and forth (period 5 frames) — the artifact.
const jitter = Array.from({ length: FRAMES }, (_, t) =>
  strip(32 + 12 * Math.sin((2 * Math.PI * t) / 5), t, 0),
);
// GRAIN: the same glide as drift, buried in heavy per-frame speckle.
const grainy = Array.from({ length: FRAMES }, (_, t) => strip(12 + (40 * t) / FRAMES, t, 80));
// NEAR-STATIC: a fixed bump under faint grain — the calm-presence case. The grain
// drives a would-be FAIL (reversal sits on the ~0.5 grain floor of this synthetic
// strip) while the picture barely moves, so picture activity is tiny.
const nearStatic = Array.from({ length: FRAMES }, (_, t) => strip(32, t, 6));

const driftR = scoreBeatPull(drift);
const jitterR = scoreBeatPull(jitter);
const grainHard = scoreBeatPull(grainy); // default: temporal fence on
const grainRaw = scoreBeatPull(grainy, { smoothFrames: 0 }); // fence off

console.log("drift     :", JSON.stringify(driftR));
console.log("jitter    :", JSON.stringify(jitterR));
console.log("grain raw :", JSON.stringify(grainRaw), " hardened:", JSON.stringify(grainHard));

// GOLDEN — byte-identical scores (a build gate). These exact floats were captured
// from the scorer on these fixtures BEFORE the C1 refactor that factored the
// mean-subtract → grain-fence → step[] pipeline out into frames.ts
// (fenceFrames/structuralDelta). The 0.17 calibration was earned against this math;
// any change that shifts these floats has changed the calibrated gate and MUST be
// re-justified. Keep these alongside the threshold asserts below.
assert.equal(driftR.score, 0.000311799921059464, "GOLDEN: drift score must be byte-identical");
assert.equal(jitterR.score, 0.7404814583204837, "GOLDEN: jitter score must be byte-identical");
assert.equal(grainRaw.score, 0.6800544743756005, "GOLDEN: grain-raw score must be byte-identical");
assert.equal(
  grainHard.score,
  0.5070420720154718,
  "GOLDEN: grain-hardened score must be byte-identical",
);

// A smooth glide passes.
assert.equal(driftR.beatLocked, false, "a smooth glide must pass");
assert.ok(driftR.score < 0.05, "a smooth glide has near-zero reversal");

// Back-and-forth motion fails, and survives the temporal smooth (it's structural,
// not grain).
assert.equal(jitterR.beatLocked, true, "oscillating motion must fail");
assert.ok(jitterR.score > 0.3, "oscillating motion has deep reversal");

// Grain flicker reads as snap-back WITHOUT the fence, and the fence removes a large
// chunk of it (on real footage the 48px downscale clears the rest — see header).
assert.equal(grainRaw.beatLocked, true, "raw (un-smoothed) scores grain flicker as jitter");
assert.ok(
  grainRaw.score - grainHard.score > 0.1,
  "the temporal fence must materially cut grain-driven reversal",
);

// Too few frames → inconclusive (passes rather than guessing).
const sparse = scoreBeatPull(jitter.slice(0, 6));
assert.ok(sparse.inconclusive, "a handful of frames is inconclusive");
assert.equal(sparse.beatLocked, false, "inconclusive never fails the gate");

// LOW-MOTION CARVE-OUT (the presence clause). The near-static clip's grain drives a
// score above threshold, but its picture activity is tiny — a calm presence clip,
// not a snap-back. With the carve-out armed (floor above its activity) the would-be
// FAIL is reported as inconclusive("lowMotion") and does NOT fail the gate.
const nearStaticOff = scoreBeatPull(nearStatic, { lowMotionFloor: 0 });
const nearStaticOn = scoreBeatPull(nearStatic, {
  lowMotionFloor: nearStaticOff.pictureActivity + 1,
});
console.log("nearStatic:", JSON.stringify({ off: nearStaticOff, on: nearStaticOn }));
assert.ok(nearStaticOff.score >= 0.16, "the near-static grain drives a would-be FAIL score");
assert.equal(nearStaticOff.beatLocked, true, "with the carve-out disabled the grain floor FAILS");
assert.equal(nearStaticOn.inconclusive, "lowMotion", "below the floor a FAIL becomes lowMotion");
assert.equal(nearStaticOn.beatLocked, false, "the carve-out never fails the gate");
assert.equal(nearStaticOn.score, nearStaticOff.score, "the carve-out reports the same raw score");

// SURGICAL: the carve-out only fires below the floor. A genuine oscillation carries
// high picture activity, so the SAME floor never softens it — the jitter still FAILS.
const jitterFloored = scoreBeatPull(jitter, { lowMotionFloor: nearStaticOff.pictureActivity + 1 });
assert.equal(
  jitterFloored.beatLocked,
  true,
  "a real oscillation stays FAIL — activity is above the floor",
);
assert.ok(
  jitterFloored.pictureActivity > nearStaticOff.pictureActivity,
  "oscillation activity dwarfs the near-static clip's",
);

// A clip that already PASSES is never turned inconclusive by the carve-out.
const driftFloored = scoreBeatPull(drift, { lowMotionFloor: 1e6 });
assert.equal(driftFloored.beatLocked, false, "a clean glide stays a pass under any floor");
assert.equal(
  driftFloored.inconclusive,
  undefined,
  "the carve-out only ever softens a would-be FAIL",
);

console.log(
  "✓ beat-pull scorer: drift passes, oscillation fails, the grain fence cuts flicker, the low-motion carve-out softens calm presence without disarming the jump detector",
);
