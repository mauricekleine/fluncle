// Unit tests for the PURE composite math inside the audio-reactivity bus
// (bun:test, named blocks). Only the exported pure helpers are exercised — no
// React rendering, no Remotion context.

import { expect, test } from "bun:test";

import { type EnergySample } from "../types";
import {
  computeDisturbance,
  computeHit,
  computeSwell,
  dropEnvelope,
  findPeakTimeMs,
  resolveDropPeakTimeMs,
} from "./use-audio-reactivity";

// ---------------------------------------------------------------------------
// findPeakTimeMs + resolveDropPeakTimeMs (the drop default)
// ---------------------------------------------------------------------------

const spikyCurve: EnergySample[] = [
  { energy: 0.4, timeMs: 0 },
  { energy: 1.0, timeMs: 2000 }, // the loudest instantaneous sample (a lone kick)
  { energy: 0.3, timeMs: 4000 },
  { energy: 0.9, timeMs: 9000 }, // the actual drop's level
];

test("findPeakTimeMs: empty curve yields undefined", () => {
  expect(findPeakTimeMs([])).toBeUndefined();
});

test("findPeakTimeMs: picks the loudest sample (first of ties)", () => {
  expect(findPeakTimeMs(spikyCurve)).toBe(2000);
  const ties: EnergySample[] = [
    { energy: 0.8, timeMs: 100 },
    { energy: 0.8, timeMs: 200 },
  ];
  expect(findPeakTimeMs(ties)).toBe(100);
});

test("resolveDropPeakTimeMs: the analyzer's dropMs wins over the loudest sample", () => {
  expect(resolveDropPeakTimeMs(9000, spikyCurve)).toBe(9000);
});

test("resolveDropPeakTimeMs: falls back to the loudest sample without dropMs", () => {
  expect(resolveDropPeakTimeMs(undefined, spikyCurve)).toBe(2000);
  expect(resolveDropPeakTimeMs(undefined, [])).toBeUndefined();
});

// ---------------------------------------------------------------------------
// dropEnvelope
// ---------------------------------------------------------------------------

test("dropEnvelope: no peak at all reads 0", () => {
  expect(dropEnvelope(1000, undefined, undefined)).toBe(0);
});

test("dropEnvelope: 1.0 at the peak, 0 well before the rise and after the fall", () => {
  const peak = 5000;
  expect(dropEnvelope(peak, peak, undefined)).toBe(1);
  expect(dropEnvelope(peak - 2000, peak, undefined)).toBe(0); // default rise 700ms
  expect(dropEnvelope(peak + 3000, peak, undefined)).toBe(0); // hold 250 + fall 900
});

test("dropEnvelope: holds 1.0 through the hold window and rises monotonically", () => {
  const peak = 5000;
  expect(dropEnvelope(peak + 200, peak, undefined)).toBe(1); // inside default 250ms hold
  const a = dropEnvelope(peak - 600, peak, undefined);
  const b = dropEnvelope(peak - 300, peak, undefined);
  expect(a).toBeGreaterThan(0);
  expect(b).toBeGreaterThan(a);
});

test("dropEnvelope: explicit options.peakTimeMs overrides the detected peak", () => {
  expect(dropEnvelope(8000, 5000, { peakTimeMs: 8000 })).toBe(1);
  expect(dropEnvelope(5000, 5000, { peakTimeMs: 8000 })).toBe(0);
});

test("dropEnvelope: floor is kept outside the drop window", () => {
  expect(dropEnvelope(0, 20_000, { floor: 0.2 })).toBeCloseTo(0.2, 6);
  expect(dropEnvelope(20_000, 20_000, { floor: 0.2 })).toBe(1);
});

// ---------------------------------------------------------------------------
// Composites
// ---------------------------------------------------------------------------

test("computeHit: default weights and the 0..1 clamp", () => {
  expect(computeHit(0, 0)).toBe(0);
  expect(computeHit(0.5, 0)).toBeCloseTo(0.31, 6); // 0.5 * 0.62
  expect(computeHit(0, 0.5)).toBeCloseTo(0.25, 6); // 0.5 * 0.5
  expect(computeHit(1, 1)).toBe(1); // 0.62 + 0.5 clamps
  expect(computeHit(1, 1, 0.3, 0.3)).toBeCloseTo(0.6, 6);
});

test("computeSwell: bass+energy sum to 1.0 at a real drop; the beat term defaults OFF", () => {
  expect(computeSwell(0, 1, 1)).toBe(1); // 0.6 + 0.4 — the Motion-law guarantee
  expect(computeSwell(1, 0, 0)).toBe(0); // per-beat weight defaults to 0 (no jitter)
  expect(computeSwell(1, 0, 0, 0.2)).toBeCloseTo(0.2, 6); // opt-in beat weight
  expect(computeSwell(0, 0.5, 0.5)).toBeCloseTo(0.5, 6);
});

test("computeDisturbance: hit+swell+drop weighting, clamped", () => {
  expect(computeDisturbance(0, 0, 0)).toBe(0);
  expect(computeDisturbance(1, 0, 0)).toBeCloseTo(0.6, 6);
  expect(computeDisturbance(0, 1, 0)).toBeCloseTo(0.45, 6);
  expect(computeDisturbance(0, 0, 1)).toBeCloseTo(0.25, 6);
  expect(computeDisturbance(1, 1, 1)).toBe(1); // 1.3 clamps to 1
});
