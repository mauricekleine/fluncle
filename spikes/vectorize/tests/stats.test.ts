import { describe, expect, test } from "bun:test";

import { percentileSorted, summarize } from "../lib/stats";

describe("percentileSorted", () => {
  const sorted = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100

  test("p50 / p95 / p99 nearest-rank", () => {
    expect(percentileSorted(sorted, 50)).toBe(50);
    expect(percentileSorted(sorted, 95)).toBe(95);
    expect(percentileSorted(sorted, 99)).toBe(99);
  });
  test("p100 is the max, p1 near the min", () => {
    expect(percentileSorted(sorted, 100)).toBe(100);
    expect(percentileSorted(sorted, 1)).toBe(1);
  });
  test("empty → 0", () => {
    expect(percentileSorted([], 95)).toBe(0);
  });
});

describe("summarize", () => {
  test("computes min/max/mean/percentiles", () => {
    const s = summarize([10, 20, 30, 40, 50]);
    expect(s.count).toBe(5);
    expect(s.min).toBe(10);
    expect(s.max).toBe(50);
    expect(s.mean).toBe(30);
    expect(s.p50).toBe(30);
  });
  test("does not mutate its input", () => {
    const input = [3, 1, 2];
    summarize(input);
    expect(input).toEqual([3, 1, 2]);
  });
  test("empty sample → all zeros", () => {
    const s = summarize([]);
    expect(s).toEqual({ count: 0, max: 0, mean: 0, min: 0, p50: 0, p95: 0, p99: 0 });
  });
});
