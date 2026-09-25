import assert from "node:assert/strict";

import { scoreBeatPull } from "./detect-beat-pull";

const N = 64;
const FRAMES = 300;
const SIGMA = 6;

const bump = (pos: number, x: number): number =>
  200 * Math.exp(-((x - pos) ** 2) / (2 * SIGMA * SIGMA));

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

const drift = Array.from({ length: FRAMES }, (_, t) => strip(12 + (40 * t) / FRAMES, t, 0));

const jitter = Array.from({ length: FRAMES }, (_, t) =>
  strip(32 + 12 * Math.sin((2 * Math.PI * t) / 5), t, 0),
);

const grainy = Array.from({ length: FRAMES }, (_, t) => strip(12 + (40 * t) / FRAMES, t, 80));

const nearStatic = Array.from({ length: FRAMES }, (_, t) => strip(32, t, 6));

const driftR = scoreBeatPull(drift);
const jitterR = scoreBeatPull(jitter);
const grainHard = scoreBeatPull(grainy);
const grainRaw = scoreBeatPull(grainy, { smoothFrames: 0 });

console.log("drift     :", JSON.stringify(driftR));
console.log("jitter    :", JSON.stringify(jitterR));
console.log("grain raw :", JSON.stringify(grainRaw), " hardened:", JSON.stringify(grainHard));

assert.equal(driftR.score, 0.000311799921059464, "GOLDEN: drift score must be byte-identical");
assert.equal(jitterR.score, 0.7404814583204837, "GOLDEN: jitter score must be byte-identical");
assert.equal(grainRaw.score, 0.6800544743756005, "GOLDEN: grain-raw score must be byte-identical");
assert.equal(
  grainHard.score,
  0.5070420720154718,
  "GOLDEN: grain-hardened score must be byte-identical",
);

assert.equal(driftR.beatLocked, false, "a smooth glide must pass");
assert.ok(driftR.score < 0.05, "a smooth glide has near-zero reversal");

assert.equal(jitterR.beatLocked, true, "oscillating motion must fail");
assert.ok(jitterR.score > 0.3, "oscillating motion has deep reversal");

assert.equal(grainRaw.beatLocked, true, "raw (un-smoothed) scores grain flicker as jitter");
assert.ok(
  grainRaw.score - grainHard.score > 0.1,
  "the temporal fence must materially cut grain-driven reversal",
);

const sparse = scoreBeatPull(jitter.slice(0, 6));
assert.ok(sparse.inconclusive, "a handful of frames is inconclusive");
assert.equal(sparse.beatLocked, false, "inconclusive never fails the gate");

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
