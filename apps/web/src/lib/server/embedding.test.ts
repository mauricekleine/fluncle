import { describe, expect, it } from "vitest";
import { coerceEmbedding, cosineSimilarity, EMBEDDING_DIMS, rankBySimilarity } from "./embedding";

// The pure core of the MuQ audio-embedding pipeline (docs/track-lifecycle.md):
// the shape gate the embed step's write-back leans on (coerce) and the cosine
// ranking the public `list_similar_tracks` op + the `/log` "more like this" row read.
// Fixture vectors only — no DB, no network.

/** A dense 1024-d vector, each slot from `fill(index)` (defaults to 0). */
function vec(fill: (index: number) => number = () => 0): number[] {
  return Array.from({ length: EMBEDDING_DIMS }, (_unused, index) => fill(index));
}

describe("coerceEmbedding — the write-back shape gate", () => {
  it("accepts a dense 1024-d finite-number array", () => {
    const raw = vec((index) => index / EMBEDDING_DIMS);
    expect(coerceEmbedding(raw)).toEqual(raw);
  });

  it("rejects the wrong length (a truncated MuQ run can't poison the space)", () => {
    expect(coerceEmbedding(vec().slice(0, 1023))).toBeNull();
    expect(coerceEmbedding([...vec(), 0])).toBeNull();
    expect(coerceEmbedding([])).toBeNull();
  });

  it("rejects a non-finite or non-number element", () => {
    const withNaN = vec();
    withNaN[500] = Number.NaN;
    expect(coerceEmbedding(withNaN)).toBeNull();

    const withInfinity = vec();
    withInfinity[0] = Number.POSITIVE_INFINITY;
    expect(coerceEmbedding(withInfinity)).toBeNull();

    const withString = vec() as unknown[];
    withString[3] = "0.5";
    expect(coerceEmbedding(withString)).toBeNull();
  });

  it("rejects non-array input", () => {
    expect(coerceEmbedding(null)).toBeNull();
    expect(coerceEmbedding(undefined)).toBeNull();
    expect(coerceEmbedding({ length: EMBEDDING_DIMS })).toBeNull();
    expect(coerceEmbedding("[]")).toBeNull();
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for identical direction and -1 for opposite", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1, 10);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("is scale-invariant (unnormalized vectors rank the same)", () => {
    // A vector and its 5× scaling point the same way → similarity 1.
    expect(cosineSimilarity([2, 1], [10, 5])).toBeCloseTo(1, 10);
  });

  it("is 0 (never NaN) against a zero-magnitude vector", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });
});

describe("rankBySimilarity — the more-like-this ordering", () => {
  const target = [1, 0];
  const candidates = [
    { embedding: [-1, 0], item: "opposite" },
    { embedding: [1, 1], item: "diagonal" },
    { embedding: [1, 0], item: "identical" },
    { embedding: [0, 1], item: "orthogonal" },
  ];

  it("orders candidates by descending cosine similarity", () => {
    expect(rankBySimilarity(target, candidates, 4)).toEqual([
      "identical",
      "diagonal",
      "orthogonal",
      "opposite",
    ]);
  });

  it("respects the limit (the top-N)", () => {
    expect(rankBySimilarity(target, candidates, 2)).toEqual(["identical", "diagonal"]);
  });

  it("returns nothing for a non-positive limit or no candidates", () => {
    expect(rankBySimilarity(target, candidates, 0)).toEqual([]);
    expect(rankBySimilarity(target, candidates, -3)).toEqual([]);
    expect(rankBySimilarity(target, [], 5)).toEqual([]);
  });

  it("breaks ties deterministically toward the earlier candidate", () => {
    const tied = [
      { embedding: [1, 0], item: "first" },
      { embedding: [2, 0], item: "second" }, // same direction as `first` → equal cosine
    ];
    expect(rankBySimilarity(target, tied, 2)).toEqual(["first", "second"]);
  });
});
