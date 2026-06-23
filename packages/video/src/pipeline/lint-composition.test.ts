// Self-running asserts for the global-vs-internal motion lint (bun test executes the
// top-level asserts; "0 tests" is the repo pattern). Locks the two named anti-patterns
// from out/overnight/INSIGHTS.md + two legitimate forms that must NOT flag.

import assert from "node:assert/strict";

import { lintComposition } from "./lint-composition";

// Bug 1 (019.3.9J watered-silk): audio on a translation term with NO constant base
// → drift velocity follows d(swell)/dt and reverses (the DJ-scratch).
const bug1 = lintComposition("  float drift = u_audioSwell * 0.10;");
assert.equal(bug1.length, 1, "audio drift with no constant base must flag");
assert.equal(bug1[0].reason, "no-constant-base", "bug1 reason = no-constant-base");

// Bug 2 (011.6.8K tide-screen): an audio coefficient >= the constant-clock coefficient
// → with swell uncapped, its derivative surges the drift (the whole-vehicle jump).
const bug2 = lintComposition("  drift = sec * 0.85 + swell * 1.4 + drop * 0.5;");
assert.equal(bug2.length, 1, "audio coeff >= clock coeff must flag");
assert.equal(bug2[0].reason, "audio-exceeds-clock", "bug2 reason = audio-exceeds-clock");

// Clean 1 (018.5.7Y cold-murmuration exemplar): global drift is a pure audio-free clock;
// audio drives only an INTERNAL knob (warp amplitude) → no finding.
const clean1 = lintComposition(
  ["  vec2 p = P + travelDir * (u_time * 0.05);", "  float warpAmp = 0.12 + 0.16 * u_mid;"].join(
    "\n",
  ),
);
assert.equal(clean1.length, 0, "audio-free clock drift + audio on internal warpAmp is clean");

// Clean 2: audio may bend translation SPEED under a DOMINANT constant base (0.6 < 1.4).
const clean2 = lintComposition(
  "  flow = radius * 3.0 - u_time * 0.85 - u_rise * 1.4 - u_audioSwell * 0.6;",
);
assert.equal(clean2.length, 0, "audio coeff under the clock coeff is allowed");

// A commented-out anti-pattern must NOT trip the lint.
const commented = lintComposition("  // float drift = u_audioSwell * 0.10;");
assert.equal(commented.length, 0, "a commented-out term is ignored");

console.log(
  `motion-lint: bug1=${bug1[0].reason} bug2=${bug2[0].reason} clean1=${clean1.length} clean2=${clean2.length} commented=${commented.length}`,
);
console.log(
  "✓ motion-lint: flags no-constant-base + audio-exceeds-clock; passes the audio-free clock + the dominant-base bend",
);
