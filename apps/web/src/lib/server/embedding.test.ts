import { describe, expect, it } from "vitest";
import {
  coerceEmbedding,
  cosineSimilarity,
  dequantizeInt8,
  EMBEDDING_DIMS,
  quantizeToInt8,
  rankBySimilarity,
  readRawBlob,
} from "./embedding";

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

// ── The int8 coarse-scan code + its recall contract (RFC vector-search-scale, slice A) ────────
// `quantizeToInt8` is the pure, no-DB model of libSQL's `vector8` (the DATABASE stores the real
// bytes; this models the SAME linear 0..255 quantization so the coarse-vs-exact recall property
// can be proven on fixtures). The two-pass scan (lib/server/vector-search.ts) leans on exactly the
// property proven here: the coarse int8 ordering keeps the true top-K within its top-N, and the
// exact rescore then recovers the precise order.

describe("quantizeToInt8 — the linear 0..255 code (a model of libSQL's vector8)", () => {
  it("maps a known vector onto the 0..255 grid by its own [min, max]", () => {
    // min = 0, max = 1: 0 → 0, 0.5 → round(0.5·255) = 128, 1 → 255.
    expect(quantizeToInt8([0, 0.5, 1])).toEqual([0, 128, 255]);
    // A shifted, wider range: min = −1, max = 3, span = 4. −1 → 0, 1 → round(0.5·255) = 128, 3 → 255.
    expect(quantizeToInt8([-1, 1, 3])).toEqual([0, 128, 255]);
  });

  it("collapses a degenerate (all-equal) vector to zeroes, never dividing by zero", () => {
    expect(quantizeToInt8([3, 3, 3])).toEqual([0, 0, 0]);
    expect(quantizeToInt8([])).toEqual([]);
  });

  it("dequantizes back toward the original range (a bounded round-trip)", () => {
    const original = [-1, 0, 0.25, 1];
    const codes = quantizeToInt8(original);
    const restored = dequantizeInt8(codes, -1, 1);

    for (let index = 0; index < original.length; index += 1) {
      // Within one quantization step (span/255 = 2/255 ≈ 0.008) of the original.
      expect(Math.abs((restored[index] ?? 0) - (original[index] ?? 0))).toBeLessThan(0.01);
    }
  });
});

describe("readRawBlob — re-binding a stored vector blob as a probe", () => {
  it("normalizes an ArrayBuffer and a typed-array view to Uint8Array, and rejects non-blobs", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);

    expect(readRawBlob(bytes.buffer)).toEqual(bytes);
    expect(readRawBlob(bytes)).toEqual(bytes);
    // A view with a non-zero offset copies only its own window.
    expect(readRawBlob(new Uint8Array(bytes.buffer, 1, 2))).toEqual(new Uint8Array([2, 3]));
    expect(readRawBlob(null)).toBeNull();
    expect(readRawBlob("[1,2,3]")).toBeNull();
    expect(readRawBlob(42)).toBeNull();
  });
});

describe("the coarse+rescore recall contract (proven on the int8 model)", () => {
  // A deterministic PRNG so the fixture is fixed run-to-run.
  function mulberry32(seed: number): () => number {
    let state = seed;

    return () => {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
  }

  /** Cosine-rank the corpus against `probe` on the given vectors, nearest first → row indices. */
  function rankTopIds(
    probe: number[],
    vectorOf: (index: number) => number[],
    count: number,
    k: number,
  ): number[] {
    return Array.from({ length: count }, (_unused, index) => ({
      index,
      score: cosineSimilarity(probe, vectorOf(index)),
    }))
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, k)
      .map((entry) => entry.index);
  }

  it("keeps the exact top-K inside the coarse top-N, and the rescore recovers the exact order", () => {
    const random = mulberry32(1234);
    const count = 400;
    const dims = 64;
    const k = 12;
    const coarseN = k * 8; // COARSE_OVERFETCH

    // A fixed corpus of dense vectors + the per-vector [min,max] the int8 model needs.
    const exact: number[][] = [];
    const codes: number[][] = [];
    const ranges: { max: number; min: number }[] = [];

    for (let i = 0; i < count; i += 1) {
      const v = Array.from({ length: dims }, () => random() * 2 - 1);
      exact.push(v);
      codes.push(quantizeToInt8(v));
      ranges.push({ max: Math.max(...v), min: Math.min(...v) });
    }

    // The dequantized (approximate) vectors the COARSE pass effectively ranks.
    const approx = codes.map((code, index) => {
      const range = ranges[index] ?? { max: 1, min: 0 };

      return dequantizeInt8(code, range.min, range.max);
    });

    let recallHits = 0;
    let orderMatches = 0;
    const trials = 40;

    for (let t = 0; t < trials; t += 1) {
      const probe = exact[Math.floor(random() * count)] ?? exact[0] ?? [];
      const exactTopK = rankTopIds(probe, (i) => exact[i] ?? [], count, k);

      // COARSE pass: top-N by the int8 (dequantized) codes.
      const coarseIds = rankTopIds(probe, (i) => approx[i] ?? [], count, coarseN);
      const coarseSet = new Set(coarseIds);
      recallHits += exactTopK.filter((id) => coarseSet.has(id)).length;

      // RESCORE: re-rank ONLY the coarse candidates by the EXACT vectors → final top-K.
      const rescored = coarseIds
        .map((id) => ({ id, score: cosineSimilarity(probe, exact[id] ?? []) }))
        .sort((left, right) => right.score - left.score || left.id - right.id)
        .slice(0, k)
        .map((entry) => entry.id);

      if (JSON.stringify(rescored) === JSON.stringify(exactTopK)) {
        orderMatches += 1;
      }
    }

    // The coarse top-N retains 100% of the exact top-K (the recall guarantee)…
    expect(recallHits).toBe(trials * k);
    // …and rescoring those candidates reproduces the exact float32 order on every trial.
    expect(orderMatches).toBe(trials);
  });
});
