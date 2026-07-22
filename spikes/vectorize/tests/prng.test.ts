import { describe, expect, test } from "bun:test";

import { gaussian, intBetween, mulberry32 } from "../lib/prng";

describe("mulberry32", () => {
  test("same seed → identical stream (reproducible)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  test("different seeds diverge", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(a()).not.toEqual(b());
  });

  test("outputs are in [0, 1)", () => {
    const r = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("gaussian", () => {
  test("deterministic for a seed and roughly zero-mean", () => {
    const r1 = mulberry32(99);
    const r2 = mulberry32(99);
    expect(gaussian(r1)).toBeCloseTo(gaussian(r2), 12);

    const r = mulberry32(3);
    let sum = 0;
    const N = 20_000;
    for (let i = 0; i < N; i++) {
      sum += gaussian(r);
    }
    expect(Math.abs(sum / N)).toBeLessThan(0.05);
  });
});

describe("intBetween", () => {
  test("stays within inclusive bounds", () => {
    const r = mulberry32(5);
    for (let i = 0; i < 5000; i++) {
      const v = intBetween(r, 60, 200);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(60);
      expect(v).toBeLessThanOrEqual(200);
    }
  });
});
