// Self-running check for the beat-pull scorer's MATH — no GPU, no ffmpeg, no test
// framework. Builds synthetic frame sequences (a 1-D gray strip with a moving bump)
// and asserts the scorer flags only the one that jitters back and forth:
//   - DRIFT : the bump glides across → low reversal → passes.
//   - JITTER: the bump snaps between two spots every couple frames → high reversal → FAILS.
//   - SURGE : the bump glides AND the whole strip flashes bright on a beat → the
//             brightness is normalised away, motion is still a glide → passes. This
//             is the false positive the first (modulation-based) metric got wrong:
//             a crisp on-beat hit that advances and flows is what doctrine 9 wants.
// Run: `bun src/pipeline/detect-beat-pull.test.ts` (exits non-zero on failure).
//
// Threshold calibration (real rendered clips, mean short-lag reversal):
//   clean cluster  004.7.2I 0.20 · 004.4.3L 0.21 · 004.0.1C 0.24   (incl. 004.4.3L,
//                  which HITS hard on the beat but does not snap back — operator-clean)
//   borderline     004.4.8B 0.33
//   pulls          004.6.0K 0.42 (operator-confirmed) · 004.6.0Q 0.48
// A wide gap → threshold 0.35 flags the clear pulls and clears the clean ones.

import assert from "node:assert/strict";

import { scoreBeatPull } from "./detect-beat-pull";

const N = 64; // pixels across the strip
const FRAMES = 300;
const SIGMA = 6;

// A gray strip with a bright gaussian bump at `pos`, over a flat `baseline`.
const strip = (pos: number, baseline: number): Float32Array => {
  const f = new Float32Array(N);
  for (let x = 0; x < N; x++) {
    f[x] = baseline + 200 * Math.exp(-((x - pos) ** 2) / (2 * SIGMA * SIGMA));
  }
  return f;
};

const drift = Array.from({ length: FRAMES }, (_, t) => strip(12 + (40 * t) / FRAMES, 30));

// Snaps between two positions every 2 frames — pure back-and-forth.
const jitter = Array.from({ length: FRAMES }, (_, t) =>
  strip(Math.floor(t / 2) % 2 === 0 ? 26 : 40, 30),
);

// Same glide as drift, plus a full-strip brightness flash every 10 frames (an
// on-beat material pulse). Normalisation must remove the flash, leaving a glide.
const surge = Array.from({ length: FRAMES }, (_, t) =>
  strip(12 + (40 * t) / FRAMES, t % 10 < 2 ? 200 : 30),
);

const driftR = scoreBeatPull(drift);
const jitterR = scoreBeatPull(jitter);
const surgeR = scoreBeatPull(surge);

console.log("drift :", JSON.stringify(driftR));
console.log("jitter:", JSON.stringify(jitterR));
console.log("surge :", JSON.stringify(surgeR));

assert.equal(driftR.beatLocked, false, "a smooth glide must pass");
assert.equal(jitterR.beatLocked, true, "back-and-forth snapping must fail");
assert.equal(surgeR.beatLocked, false, "an on-beat brightness pulse over a glide must pass");

assert.ok(jitterR.score > driftR.score, "jitter must reverse more than a glide");
assert.ok(jitterR.score > surgeR.score, "jitter must reverse more than a flashing glide");
assert.ok(surgeR.score < 0.35, "the flash must normalise away, leaving low reversal");

// Too few frames → inconclusive (passes rather than guessing).
const sparse = scoreBeatPull(jitter.slice(0, 6));
assert.ok(sparse.inconclusive, "a handful of frames is inconclusive");
assert.equal(sparse.beatLocked, false, "inconclusive never fails the gate");

console.log("✓ beat-pull scorer: glide & flashing-glide pass, back-and-forth fails");
