// Unit tests for the curve samplers (bun:test, named blocks). Pure functions —
// no Remotion context needed.

import { expect, test } from "bun:test";

import { type EnergySample } from "../types";
import { accumulateCurveAtFrame, sampleCurve, smoothCurveAtFrame } from "./sample-curve";

const curve: EnergySample[] = [
  { energy: 0.0, timeMs: 0 },
  { energy: 1.0, timeMs: 100 },
  { energy: 0.5, timeMs: 200 },
];

// ---------------------------------------------------------------------------
// sampleCurve
// ---------------------------------------------------------------------------

test("sampleCurve: empty curve reads 0 at any time", () => {
  expect(sampleCurve([], 0)).toBe(0);
  expect(sampleCurve([], 12345)).toBe(0);
});

test("sampleCurve: single sample reads its value everywhere (clamped)", () => {
  const single: EnergySample[] = [{ energy: 0.7, timeMs: 100 }];
  expect(sampleCurve(single, -50)).toBe(0.7);
  expect(sampleCurve(single, 100)).toBe(0.7);
  expect(sampleCurve(single, 9999)).toBe(0.7);
});

test("sampleCurve: out-of-range times clamp to the first/last sample", () => {
  expect(sampleCurve(curve, -100)).toBe(0.0);
  expect(sampleCurve(curve, 1000)).toBe(0.5);
});

test("sampleCurve: linear interpolation between samples", () => {
  expect(sampleCurve(curve, 50)).toBeCloseTo(0.5, 6);
  expect(sampleCurve(curve, 150)).toBeCloseTo(0.75, 6);
  expect(sampleCurve(curve, 100)).toBeCloseTo(1.0, 6);
});

test("sampleCurve: duplicate timeMs (zero span) reads the later sample", () => {
  const dup: EnergySample[] = [
    { energy: 0.2, timeMs: 0 },
    { energy: 0.4, timeMs: 100 },
    { energy: 0.9, timeMs: 100 },
    { energy: 0.1, timeMs: 200 },
  ];
  // Between 0 and 100 interpolates normally; AT the duplicated 100 the zero-span
  // guard returns the matched sample's energy without dividing by zero.
  expect(Number.isFinite(sampleCurve(dup, 100))).toBe(true);
  expect(sampleCurve(dup, 100)).toBeGreaterThanOrEqual(0.4);
  expect(sampleCurve(dup, 100)).toBeLessThanOrEqual(0.9);
});

// ---------------------------------------------------------------------------
// smoothCurveAtFrame (one-pole EMA over frames)
// ---------------------------------------------------------------------------

const FPS = 50; // 20ms per frame — frame index maps 1:1 onto the curve hops

test("smoothCurveAtFrame: empty curve reads 0", () => {
  expect(smoothCurveAtFrame([], 10, FPS, 0, 4)).toBe(0);
});

test("smoothCurveAtFrame: smoothingFrames <= 1 is the raw sample", () => {
  expect(smoothCurveAtFrame(curve, 5, FPS, 0, 1)).toBeCloseTo(sampleCurve(curve, 100), 6);
  expect(smoothCurveAtFrame(curve, 5, FPS, 0, 0)).toBeCloseTo(sampleCurve(curve, 100), 6);
});

test("smoothCurveAtFrame: EMA lags a step and converges toward it", () => {
  // A step 0 -> 1 at 500ms.
  const step: EnergySample[] = [
    { energy: 0, timeMs: 0 },
    { energy: 0, timeMs: 480 },
    { energy: 1, timeMs: 500 },
    { energy: 1, timeMs: 2000 },
  ];
  const stepFrame = Math.round((500 / 1000) * FPS);

  // Just after the step: strictly between 0 and 1 (lag), below the raw value.
  const justAfter = smoothCurveAtFrame(step, stepFrame + 1, FPS, 0, 4);
  expect(justAfter).toBeGreaterThan(0);
  expect(justAfter).toBeLessThan(1);
  expect(justAfter).toBeLessThan(sampleCurve(step, ((stepFrame + 1) / FPS) * 1000));

  // Monotone rise after the step, converging to ~1 well past it.
  const later = smoothCurveAtFrame(step, stepFrame + 6, FPS, 0, 4);
  expect(later).toBeGreaterThan(justAfter);
  const settled = smoothCurveAtFrame(step, stepFrame + 40, FPS, 0, 4);
  expect(settled).toBeGreaterThan(0.99);
});

test("smoothCurveAtFrame: out-of-range frame clamps to the last sample's value", () => {
  const settled = smoothCurveAtFrame(curve, 10_000, FPS, 0, 4);
  expect(settled).toBeCloseTo(0.5, 3);
});

test("smoothCurveAtFrame: startMs shifts the sampling window", () => {
  // With startMs = 100 the frame-0 sample sits on the curve's 100ms point.
  expect(smoothCurveAtFrame(curve, 0, FPS, 100, 1)).toBeCloseTo(1.0, 6);
});

test("smoothCurveAtFrame: deterministic (same inputs, same output)", () => {
  const a = smoothCurveAtFrame(curve, 7, FPS, 0, 3);
  const b = smoothCurveAtFrame(curve, 7, FPS, 0, 3);
  expect(a).toBe(b);
});

// ---------------------------------------------------------------------------
// accumulateCurveAtFrame (leaky integrator — "the world remembers the drop")
// ---------------------------------------------------------------------------

// A drop that spikes to 1 for 500–1000ms and then returns to 0.
const dropCurve: EnergySample[] = [
  { energy: 0, timeMs: 0 },
  { energy: 0, timeMs: 480 },
  { energy: 1, timeMs: 500 },
  { energy: 1, timeMs: 1000 },
  { energy: 0, timeMs: 1020 },
  { energy: 0, timeMs: 4000 },
];

test("accumulateCurveAtFrame: empty curve reads 0", () => {
  expect(accumulateCurveAtFrame([], 10, FPS, 0, 0.9)).toBe(0);
});

test("accumulateCurveAtFrame: decay 0 is the raw sample (no memory)", () => {
  const f = 25;
  expect(accumulateCurveAtFrame(dropCurve, f, FPS, 0, 0)).toBeCloseTo(
    sampleCurve(dropCurve, (f / FPS) * 1000),
    6,
  );
});

test("accumulateCurveAtFrame: a 0..1 curve stays in [0,1]", () => {
  for (let f = 0; f <= 200; f += 10) {
    const v = accumulateCurveAtFrame(dropCurve, f, FPS, 0, 0.9);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  }
});

test("accumulateCurveAtFrame: the world REMEMBERS the drop — after it ends, memory lingers", () => {
  // Frame ~60 = 1200ms, well after the drop ended (1020ms): the raw signal is 0.
  const after = Math.round((1200 / 1000) * FPS);
  const raw = sampleCurve(dropCurve, (after / FPS) * 1000);
  expect(raw).toBeCloseTo(0, 6);

  const highDecay = accumulateCurveAtFrame(dropCurve, after, FPS, 0, 0.92);
  const lowDecay = accumulateCurveAtFrame(dropCurve, after, FPS, 0, 0.3);

  // The high-decay world still glows from a drop the low-decay world has forgotten.
  expect(highDecay).toBeGreaterThan(0.05);
  expect(highDecay).toBeGreaterThan(lowDecay);
  expect(lowDecay).toBeLessThan(0.02);
});

test("accumulateCurveAtFrame: during a sustained surge the value CLIMBS toward 1", () => {
  const early = accumulateCurveAtFrame(dropCurve, Math.round((520 / 1000) * FPS), FPS, 0, 0.9);
  const mid = accumulateCurveAtFrame(dropCurve, Math.round((760 / 1000) * FPS), FPS, 0, 0.9);
  const late = accumulateCurveAtFrame(dropCurve, Math.round((1000 / 1000) * FPS), FPS, 0, 0.9);
  expect(mid).toBeGreaterThan(early);
  expect(late).toBeGreaterThan(mid);
  expect(late).toBeGreaterThan(0);
  expect(late).toBeLessThan(1);
});

test("accumulateCurveAtFrame: a held-1 curve converges toward 1 (normalized integrator)", () => {
  const held: EnergySample[] = [
    { energy: 1, timeMs: 0 },
    { energy: 1, timeMs: 10_000 },
  ];
  const settled = accumulateCurveAtFrame(held, 500, FPS, 0, 0.9);
  expect(settled).toBeGreaterThan(0.99);
});

test("accumulateCurveAtFrame: deterministic + frame-pure (same frame → same value regardless of start)", () => {
  // The bounded-lookback walk means the value at frame N is a pure function of N —
  // computing it fresh (as a later render chunk would) gives the identical result.
  const a = accumulateCurveAtFrame(dropCurve, 90, FPS, 0, 0.9);
  const b = accumulateCurveAtFrame(dropCurve, 90, FPS, 0, 0.9);
  expect(a).toBe(b);
});

// ---------------------------------------------------------------------------
// sampleCurve: binary search === the old forward linear scan (frame-stability)
// ---------------------------------------------------------------------------

// The ORACLE: the exact pre-optimization linear-scan implementation of sampleCurve.
// The binary-search version MUST match it bit-for-bit or renders would shift.
const sampleCurveLinearOracle = (curve: EnergySample[], timeMs: number): number => {
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
};

// A tiny deterministic PRNG so the fuzz corpus is reproducible (no test flake).
const makeRng = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
};

test("sampleCurve: binary search is bit-identical to the linear-scan oracle (randomized)", () => {
  const rng = makeRng(0xc0ffee);
  for (let trial = 0; trial < 400; trial++) {
    // Build a time-sorted curve of random length, occasionally injecting DUPLICATE
    // timeMs values (zero-span segments) since those are the tie-breaking edge case.
    const len = 1 + Math.floor(rng() * 40);
    const curve: EnergySample[] = [];
    let t = Math.floor(rng() * 50);
    for (let i = 0; i < len; i++) {
      curve.push({ energy: rng() * 2 - 0.5, timeMs: t });
      // ~25% of the time keep the same timeMs (duplicate); else advance by 0..30ms.
      t += rng() < 0.25 ? 0 : Math.floor(rng() * 30);
    }
    const lastMs = curve[curve.length - 1].timeMs;
    // Probe well outside the range on both ends AND densely inside it, plus every
    // exact sample time (the boundary values the two branches must agree on).
    const probes: number[] = [-1000, -1, lastMs + 1, lastMs + 1000];
    for (const s of curve) {
      probes.push(s.timeMs);
    }
    for (let q = 0; q < 60; q++) {
      probes.push(rng() * (lastMs + 20) - 10);
    }
    for (const timeMs of probes) {
      expect(sampleCurve(curve, timeMs)).toBe(sampleCurveLinearOracle(curve, timeMs));
    }
  }
});
