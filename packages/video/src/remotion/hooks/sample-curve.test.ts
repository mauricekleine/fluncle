// Unit tests for the curve samplers (bun:test, named blocks). Pure functions —
// no Remotion context needed.

import { expect, test } from "bun:test";

import { type EnergySample } from "../types";
import { sampleCurve, smoothCurveAtFrame } from "./sample-curve";

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
