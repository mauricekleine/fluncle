import { describe, expect, test } from "bun:test";

import { mulberry32 } from "../lib/prng";
import {
  averageUnit,
  cosine,
  DIMENSIONS,
  dot,
  magnitude,
  normalize,
  randomUnitVector,
} from "../lib/vector";

describe("cosine", () => {
  test("identical vectors → 1", () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 12);
  });

  test("orthogonal vectors → 0", () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 12);
  });

  test("opposite vectors → -1", () => {
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 12);
  });

  test("known non-trivial value", () => {
    // a=(1,1), b=(1,0): cos = 1/sqrt(2)
    expect(cosine([1, 1], [1, 0])).toBeCloseTo(1 / Math.SQRT2, 12);
  });

  test("scale-invariant (cosine ignores magnitude)", () => {
    expect(cosine([2, 4, 6], [1, 2, 3])).toBeCloseTo(1, 12);
  });

  test("zero vector → 0 (no NaN)", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe("dot / magnitude", () => {
  test("dot product", () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
  });
  test("magnitude", () => {
    expect(magnitude([3, 4])).toBe(5);
  });
});

describe("normalize", () => {
  test("produces a unit vector", () => {
    // normalize() returns a Float32Array, so equality holds to ~float32 precision.
    const u = normalize([3, 4]);
    expect(magnitude(u)).toBeCloseTo(1, 5);
    expect(u[0]).toBeCloseTo(0.6, 5);
    expect(u[1]).toBeCloseTo(0.8, 5);
  });
  test("zero vector stays zero (no divide-by-zero)", () => {
    const u = normalize([0, 0, 0]);
    expect(Array.from(u)).toEqual([0, 0, 0]);
  });
});

describe("randomUnitVector", () => {
  test("has the right dimension and unit length", () => {
    const v = randomUnitVector(mulberry32(1));
    expect(v.length).toBe(DIMENSIONS);
    expect(magnitude(v)).toBeCloseTo(1, 5);
  });
  test("deterministic per seed", () => {
    const a = randomUnitVector(mulberry32(11), 32);
    const b = randomUnitVector(mulberry32(11), 32);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe("averageUnit", () => {
  test("average of a vector with itself is that unit vector", () => {
    const v = normalize([1, 2, 3, 4]);
    const avg = averageUnit([v, v]);
    expect(magnitude(avg)).toBeCloseTo(1, 5);
    for (let i = 0; i < v.length; i++) {
      expect(avg[i]).toBeCloseTo(v[i] ?? 0, 5);
    }
  });
  test("averages toward the centroid direction", () => {
    // (1,0) and (0,1) average to a unit vector at 45°.
    const avg = averageUnit([new Float32Array([1, 0]), new Float32Array([0, 1])]);
    expect(avg[0]).toBeCloseTo(1 / Math.SQRT2, 6);
    expect(avg[1]).toBeCloseTo(1 / Math.SQRT2, 6);
  });
});
