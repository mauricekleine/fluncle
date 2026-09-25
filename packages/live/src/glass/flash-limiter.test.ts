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
    expect(isSaturatedRed(0.8, 0.1, 0.1)).toBe(true);
    expect(isSaturatedRed(0.7, 0.2, 0.1)).toBe(false);
  });

  test("R-G-B is the XAG-118 signal", () => {
    expect(redValue(1, 0, 0)).toBe(1);
    expect(redValue(0, 1, 0)).toBe(-1);
    expect(redValue(0.6, 0.1, 0.1)).toBeCloseTo(0.4, 6);
  });
});

function graySquare(low: number, high: number, halfPeriodMs: number, samples: number) {
  const seq: Array<{ t: number; r: number; g: number; b: number }> = [];
  for (let i = 0; i < samples; i++) {
    const v = i % 2 === 0 ? low : high;
    seq.push({ b: v, g: v, r: v, t: i * halfPeriodMs });
  }
  return seq;
}

describe("general-flash counting — the 3-pass / 4-fail law", () => {
  const LOW = 0.033;
  const HIGH = 0.318;

  test("a square wave completes one flash per full period", () => {
    const c = new OpposingPairCounter({ deltaThreshold: GENERAL_DELTA, qualifyMode: "darker" });
    let flashes = 0;

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

    for (let i = 0; i < 40; i++) {
      const v = i % 2 === 0 ? 0.6 : 0.62;
      if (c.observe(i * 100, relativeLuminance(v, v, v), true).flashCompleted) {
        flashes++;
      }
    }
    expect(flashes).toBe(0);
  });

  test("the darker endpoint must be below 0.80 (bright pairs are exempt)", () => {
    const c = new OpposingPairCounter({ deltaThreshold: GENERAL_DELTA, qualifyMode: "darker" });
    let flashes = 0;

    for (let i = 0; i < 20; i++) {
      const v = i % 2 === 0 ? 0.85 : 0.98;
      if (c.observe(i * 100, v, v < DARK_CEILING).flashCompleted) {
        flashes++;
      }
    }
    expect(flashes).toBe(0);
  });
});

describe("the 174 BPM = 2.9 Hz boundary case", () => {
  test("2.9 Hz opposing pairs stay under the ceiling (kick brightness passes)", () => {
    const m = new FlashMonitor();
    const halfPeriod = 1000 / 2.9 / 2;
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
    const halfPeriod = 1000 / 4 / 2;
    let tripped = false;
    graySquare(0.2, 0.6, halfPeriod, 40).forEach((s) => {
      if (m.push(s.t, s.r, s.g, s.b).tripped) {
        tripped = true;
      }
    });
    expect(tripped).toBe(true);
  });
});

describe("saturated-red limiter is independent of the general net", () => {
  const RED = { b: 0, g: 0, r: 1 };
  const GREEN = { b: 0, g: 0.545, r: 0 };

  test("equal-luminance red swings trip RED but not GENERAL", () => {
    const m = new FlashMonitor();
    let redTrip = false;
    let generalMax = 0;
    for (let i = 0; i < 40; i++) {
      const c = i % 2 === 0 ? RED : GREEN;
      const r = m.push((i * 1000) / 4 / 2, c.r, c.g, c.b);
      generalMax = Math.max(generalMax, r.general);
      if (r.tripped && r.red > MAX_FLASHES_PER_SECOND) {
        redTrip = true;
      }
    }
    expect(redTrip).toBe(true);

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

describe("FlashLimiter (source-side) eases the 4th flash instead of emitting it", () => {
  test("a runaway strobe gets eased and the emitted stream stops tripping", () => {
    const limiter = new FlashLimiter();
    const monitor = new FlashMonitor();
    let easedFrames = 0;
    let emittedTrips = 0;

    for (let f = 0; f < 180; f++) {
      const t = f * (1000 / 60);
      const phase = Math.floor((t / (1000 / 6 / 2)) % 2);
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

    expect(emittedTrips).toBe(0);
    expect(limiter.trips).toBeGreaterThan(0);
  });

  test("a calm signal is passed through untouched (scalar stays 1)", () => {
    const limiter = new FlashLimiter();
    let anyEase = false;
    for (let f = 0; f < 180; f++) {
      const t = f * (1000 / 60);

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
