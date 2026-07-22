import { describe, expect, test } from "bun:test";

import { mean, overlapAtK } from "../lib/overlap";

describe("overlapAtK", () => {
  const gt = ["a", "b", "c", "d", "e"];

  test("identical top-K → 1.0", () => {
    expect(overlapAtK(gt, ["a", "b", "c", "d", "e"], 5)).toBe(1);
  });

  test("disjoint → 0", () => {
    expect(overlapAtK(gt, ["v", "w", "x", "y", "z"], 5)).toBe(0);
  });

  test("half overlap at K=4", () => {
    // gt[0..4)={a,b,c,d}; cand[0..4)={a,b,x,y} → 2/4
    expect(overlapAtK(gt, ["a", "b", "x", "y", "z"], 4)).toBeCloseTo(0.5, 12);
  });

  test("order within the top-K does not matter (set intersection)", () => {
    expect(overlapAtK(gt, ["c", "a", "b"], 3)).toBe(1);
  });

  test("only the first K of each list count", () => {
    // K=2: gt{a,b}; cand first 2 = {z, a} → 1/2
    expect(overlapAtK(gt, ["z", "a", "b", "c"], 2)).toBeCloseTo(0.5, 12);
  });

  test("K clamps to ground-truth length", () => {
    expect(overlapAtK(["a", "b"], ["a", "b", "c"], 10)).toBe(1);
  });

  test("K<=0 or empty → 0", () => {
    expect(overlapAtK([], ["a"], 5)).toBe(0);
    expect(overlapAtK(gt, ["a"], 0)).toBe(0);
  });
});

describe("mean", () => {
  test("averages", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });
  test("empty → 0", () => {
    expect(mean([])).toBe(0);
  });
});
