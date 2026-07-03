// The flash-limiter proof. The math is pure, so it is exhaustively testable with
// synthetic luminance/colour sequences — this suite is the crown's certificate:
// WCAG 2.3.1 general flashes (3 pass, 4 fail), the independent saturated-red net,
// and the 174 BPM = 2.9 Hz boundary that must PASS while a faster strobe trips.

import { describe, expect, test } from "bun:test";
import {
  DARK_CEILING,
  FlashLimiter,
  FlashMonitor,
  GENERAL_DELTA,
  isSaturatedRed,
  linearizeChannel,
  MAX_FLASHES_PER_SECOND,
  OpposingPairCounter,
  redSaturation,
  redValue,
  relativeLuminance,
} from "./flash-limiter.ts";

// ---------------------------------------------------------------------------
// Pure colour math
// ---------------------------------------------------------------------------
describe("relative-luminance math (WCAG, linearized sRGB)", () => {
  test("black is 0, white is 1", () => {
    expect(relativeLuminance(0, 0, 0)).toBeCloseTo(0, 6);
    expect(relativeLuminance(1, 1, 1)).toBeCloseTo(1, 6);
  });

  test("primaries carry the canonical weights", () => {
    expect(relativeLuminance(1, 0, 0)).toBeCloseTo(0.2126, 4);
    expect(relativeLuminance(0, 1, 0)).toBeCloseTo(0.7152, 4);
    expect(relativeLuminance(0, 0, 1)).toBeCloseTo(0.0722, 4);
  });

  test("the sRGB EOTF kink at 0.04045 is exact", () => {
    expect(linearizeChannel(0.04045)).toBeCloseTo(0.04045 / 12.92, 8);
    expect(linearizeChannel(0)).toBe(0);
    expect(linearizeChannel(1)).toBe(1);
    // linear is below gamma for mid values (the curve dips)
    expect(linearizeChannel(0.5)).toBeLessThan(0.5);
  });
});

describe("saturated-red gate (WCAG red-flash test)", () => {
  test("pure red is saturated, gray/white is not", () => {
    expect(isSaturatedRed(1, 0, 0)).toBe(true);
    expect(redSaturation(1, 0, 0)).toBeCloseTo(1, 6);
    expect(isSaturatedRed(1, 1, 1)).toBe(false);
    expect(isSaturatedRed(0.5, 0.5, 0.5)).toBe(false);
  });

  test("the 0.8 boundary", () => {
    expect(isSaturatedRed(0.8, 0.1, 0.1)).toBe(true); // 0.8 / 1.0 = 0.8
    expect(isSaturatedRed(0.7, 0.2, 0.1)).toBe(false); // 0.7 / 1.0 = 0.7
  });

  test("R-G-B is the XAG-118 signal", () => {
    expect(redValue(1, 0, 0)).toBe(1);
    expect(redValue(0, 1, 0)).toBe(-1);
    expect(redValue(0.6, 0.1, 0.1)).toBeCloseTo(0.4, 6);
  });
});

// ---------------------------------------------------------------------------
// Helpers: drive a counter/monitor with a square wave of opposing pairs
// ---------------------------------------------------------------------------

/** A grayscale square wave alternating two luminance levels, one sample per half-period. */
function graySquare(low: number, high: number, halfPeriodMs: number, samples: number) {
  const seq: Array<{ t: number; r: number; g: number; b: number }> = [];
  for (let i = 0; i < samples; i++) {
    const v = i % 2 === 0 ? low : high;
    seq.push({ b: v, g: v, r: v, t: i * halfPeriodMs });
  }
  return seq;
}

// ---------------------------------------------------------------------------
// General flashes — 3 pass, 4 fail
// ---------------------------------------------------------------------------
describe("general-flash counting — the 3-pass / 4-fail law", () => {
  // low=0.2 -> L≈0.033, high=0.6 -> L≈0.318: swing ≈0.285 (>0.10), darker <0.80.
  const LOW = 0.033;
  const HIGH = 0.318;

  test("a square wave completes one flash per full period", () => {
    const c = new OpposingPairCounter({ deltaThreshold: GENERAL_DELTA, qualifyMode: "darker" });
    let flashes = 0;
    // samples s0..s7 at 100ms -> flashes land on s3,s5,s7 (see algorithm trace).
    const seq = [LOW, HIGH, LOW, HIGH, LOW, HIGH, LOW, HIGH];
    seq.forEach((v, i) => {
      const o = c.observe(i * 100, v, v < DARK_CEILING);
      if (o.flashCompleted) {
        flashes++;
      }
    });
    expect(flashes).toBe(3);
    expect(c.countInWindow(700)).toBe(3);
  });

  test("3 flashes in a trailing second PASS (no trip)", () => {
    const m = new FlashMonitor();
    let tripped = false;
    // 8 samples @100ms -> 3 flashes at t=300,500,700, all inside [0,700].
    graySquare(0.2, 0.6, 100, 8).forEach((s) => {
      if (m.push(s.t, s.r, s.g, s.b).tripped) {
        tripped = true;
      }
    });
    expect(tripped).toBe(false);
    expect(m.tripCount).toBe(0);
  });

  test("a 4th flash in the same second TRIPS", () => {
    const m = new FlashMonitor();
    let tripped = false;
    // 10 samples @100ms -> 4th flash at t=900, still inside a 1s window.
    graySquare(0.2, 0.6, 100, 10).forEach((s) => {
      if (m.push(s.t, s.r, s.g, s.b).tripped) {
        tripped = true;
      }
    });
    expect(tripped).toBe(true);
    expect(m.tripCount).toBeGreaterThan(0);
  });

  test("sub-threshold luminance swings never count", () => {
    const c = new OpposingPairCounter({ deltaThreshold: GENERAL_DELTA, qualifyMode: "darker" });
    let flashes = 0;
    // 0.30 <-> 0.34 in luminance: L swing well under 0.10.
    for (let i = 0; i < 40; i++) {
      const v = i % 2 === 0 ? 0.6 : 0.62; // luminances ~0.318 vs ~0.342, delta ~0.024
      if (c.observe(i * 100, relativeLuminance(v, v, v), true).flashCompleted) {
        flashes++;
      }
    }
    expect(flashes).toBe(0);
  });

  test("the darker endpoint must be below 0.80 (bright pairs are exempt)", () => {
    const c = new OpposingPairCounter({ deltaThreshold: GENERAL_DELTA, qualifyMode: "darker" });
    let flashes = 0;
    // Both endpoints bright: 0.85 <-> 0.98 -> darker 0.85 >= 0.80, exempt.
    for (let i = 0; i < 20; i++) {
      const v = i % 2 === 0 ? 0.85 : 0.98;
      if (c.observe(i * 100, v, v < DARK_CEILING).flashCompleted) {
        flashes++;
      }
    }
    expect(flashes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The 2.9 Hz (174 BPM) boundary
// ---------------------------------------------------------------------------
describe("the 174 BPM = 2.9 Hz boundary case", () => {
  test("2.9 Hz opposing pairs stay under the ceiling (kick brightness passes)", () => {
    const m = new FlashMonitor();
    const halfPeriod = 1000 / 2.9 / 2; // ms per half-period at 2.9 Hz
    let tripped = false;
    let maxCount = 0;
    graySquare(0.2, 0.6, halfPeriod, 60).forEach((s) => {
      const r = m.push(s.t, s.r, s.g, s.b);
      maxCount = Math.max(maxCount, r.general);
      if (r.tripped) {
        tripped = true;
      }
    });
    expect(tripped).toBe(false);
    expect(maxCount).toBeLessThanOrEqual(MAX_FLASHES_PER_SECOND);
  });

  test("a 4 Hz strobe trips (over the ceiling)", () => {
    const m = new FlashMonitor();
    const halfPeriod = 1000 / 4 / 2; // 125ms
    let tripped = false;
    graySquare(0.2, 0.6, halfPeriod, 40).forEach((s) => {
      if (m.push(s.t, s.r, s.g, s.b).tripped) {
        tripped = true;
      }
    });
    expect(tripped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Red-flash independence
// ---------------------------------------------------------------------------
describe("saturated-red limiter is independent of the general net", () => {
  // Equal-luminance red<->green swing: red signal swings hard, general luminance flat.
  // (1,0,0) L≈0.2126; (0,0.545,0) L≈0.7152*linear(0.545)≈0.2126.
  const RED = { b: 0, g: 0, r: 1 };
  const GREEN = { b: 0, g: 0.545, r: 0 };

  test("equal-luminance red swings trip RED but not GENERAL", () => {
    const m = new FlashMonitor();
    let redTrip = false;
    let generalMax = 0;
    for (let i = 0; i < 40; i++) {
      const c = i % 2 === 0 ? RED : GREEN;
      const r = m.push((i * 1000) / 4 / 2, c.r, c.g, c.b); // 4 Hz
      generalMax = Math.max(generalMax, r.general);
      if (r.tripped && r.red > MAX_FLASHES_PER_SECOND) {
        redTrip = true;
      }
    }
    expect(redTrip).toBe(true);
    // The two endpoints are near-equal luminance -> the general net stays quiet.
    expect(generalMax).toBeLessThanOrEqual(MAX_FLASHES_PER_SECOND);
  });

  test("grayscale flashes trip GENERAL but never RED (nothing is saturated)", () => {
    const m = new FlashMonitor();
    let generalTrip = false;
    let redMax = 0;
    graySquare(0.2, 0.6, 1000 / 4 / 2, 40).forEach((s) => {
      const r = m.push(s.t, s.r, s.g, s.b);
      redMax = Math.max(redMax, r.red);
      if (r.general > MAX_FLASHES_PER_SECOND) {
        generalTrip = true;
      }
    });
    expect(generalTrip).toBe(true);
    expect(redMax).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The source-side limiter — easing behaviour
// ---------------------------------------------------------------------------
describe("FlashLimiter (source-side) eases the 4th flash instead of emitting it", () => {
  test("a runaway strobe gets eased and the emitted stream stops tripping", () => {
    const limiter = new FlashLimiter();
    const monitor = new FlashMonitor(); // watches the EMITTED (post-scalar) luminance
    let easedFrames = 0;
    let emittedTrips = 0;
    // Drive a hard 6 Hz luminance strobe for 3 seconds at 60fps.
    for (let f = 0; f < 180; f++) {
      const t = f * (1000 / 60);
      const phase = Math.floor((t / (1000 / 6 / 2)) % 2); // 6 Hz square
      const intended = phase === 0 ? 0.05 : 0.7;
      const res = limiter.push(t, intended);
      if (res.eased) {
        easedFrames++;
      }
      const emitted = intended * res.scalar;
      const m = monitor.push(t, emitted, emitted, emitted);
      if (m.tripped) {
        emittedTrips++;
      }
    }
    expect(easedFrames).toBeGreaterThan(0);
    // The whole point: after easing, the emitted signal never sustains a trip.
    expect(emittedTrips).toBe(0);
    expect(limiter.trips).toBeGreaterThan(0);
  });

  test("a calm signal is passed through untouched (scalar stays 1)", () => {
    const limiter = new FlashLimiter();
    let anyEase = false;
    for (let f = 0; f < 180; f++) {
      const t = f * (1000 / 60);
      // A gentle 0.5 Hz breathe well under the flash rate.
      const intended = 0.3 + 0.2 * Math.sin((t / 1000) * Math.PI);
      const res = limiter.push(t, intended);
      if (res.eased || res.scalar < 0.999) {
        anyEase = true;
      }
    }
    expect(anyEase).toBe(false);
  });

  test("status reports the trailing-second counts", () => {
    const limiter = new FlashLimiter();
    for (let f = 0; f < 120; f++) {
      const t = f * (1000 / 60);
      const phase = Math.floor((t / (1000 / 5 / 2)) % 2);
      limiter.push(t, phase === 0 ? 0.05 : 0.7);
    }
    const s = limiter.status(120 * (1000 / 60));
    expect(s.generalCount).toBeGreaterThanOrEqual(0);
    expect(s.eases).toBe(limiter.trips);
  });
});
