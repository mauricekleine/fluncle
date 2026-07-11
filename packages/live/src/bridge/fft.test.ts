// The dependency-free radix-2 FFT (fft.ts) — pinned with known signals. This primitive is
// vendored from the render path and must reproduce a fingerprint exactly; mel.test.ts exercises
// it indirectly through melFrames, but these assert the transform itself: a pure sine lands its
// energy in the right bin, DC lands in bin 0, and the window helpers are well-formed.

import { describe, expect, test } from "bun:test";

import { fftInPlace, hannWindow, nextPow2 } from "./fft";

/** The magnitude spectrum |X[k]| of a real signal after fftInPlace. */
function magnitudes(signal: number[]): number[] {
  const re = Float64Array.from(signal);
  const im = new Float64Array(signal.length);
  fftInPlace(re, im);
  return Array.from(re, (r, k) => Math.hypot(r, im[k]));
}

/** The index of the largest value in the first half (the non-aliased bins). */
function peakBin(mags: number[]): number {
  const half = mags.length / 2;
  let best = 0;
  for (let k = 1; k < half; k++) {
    if (mags[k] > mags[best]) {
      best = k;
    }
  }
  return best;
}

describe("nextPow2", () => {
  test("rounds up to the next power of two", () => {
    expect(nextPow2(1)).toBe(1);
    expect(nextPow2(3)).toBe(4);
    expect(nextPow2(1024)).toBe(1024);
    expect(nextPow2(1025)).toBe(2048);
  });
});

describe("hannWindow", () => {
  test("is zero at the endpoints and peaks at the centre", () => {
    const w = hannWindow(64);
    expect(w[0]).toBeCloseTo(0, 6);
    expect(w[32]).toBeCloseTo(1, 6);
    expect(w.length).toBe(64);
  });
});

describe("fftInPlace", () => {
  test("a pure sine at bin k puts its peak at bin k", () => {
    const n = 64;
    const k0 = 8;
    const signal = Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * k0 * i) / n));
    expect(peakBin(magnitudes(signal))).toBe(k0);
  });

  test("a pure cosine at a different bin peaks at that bin", () => {
    const n = 128;
    const k0 = 20;
    const signal = Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * k0 * i) / n));
    expect(peakBin(magnitudes(signal))).toBe(k0);
  });

  test("a DC (constant) signal puts all its energy in bin 0", () => {
    const n = 32;
    const mags = magnitudes(Array.from({ length: n }, () => 1));
    expect(mags[0]).toBeCloseTo(n, 6);
    for (let k = 1; k < n; k++) {
      expect(mags[k]).toBeCloseTo(0, 6);
    }
  });

  test("a length-1 (or empty) input is a no-op", () => {
    const re = Float64Array.from([5]);
    const im = new Float64Array(1);
    expect(() => fftInPlace(re, im)).not.toThrow();
    expect(re[0]).toBe(5);
  });
});
