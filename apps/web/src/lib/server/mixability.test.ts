import { describe, expect, it } from "vitest";
import {
  bpmSubScore,
  featureDistance,
  type MixTrack,
  MIX_WEIGHTS,
  orderMixPath,
  PATH_MAX,
  parseFeatureVector,
  rankMixable,
  scoreMix,
  sonicGateOpen,
  sonicSubScore,
  transitionsAlong,
} from "./mixability";

function track(input: Partial<MixTrack>): MixTrack {
  return {
    bpm: input.bpm ?? null,
    embedding: input.embedding ?? null,
    features: input.features ?? null,
    key: input.key ?? null,
  };
}

// A key-only pair scores exactly its harmonic sub-score (BPM + sonic absent).
function harmonic(keyA: string, keyB: string): number | null {
  return scoreMix(track({ key: keyA }), track({ key: keyB })).score;
}

describe("harmonic sub-score (the Camelot table)", () => {
  it("scores every documented relationship (A minor = 8A as the anchor)", () => {
    expect(harmonic("A minor", "A minor")).toBe(1.0); // same key
    expect(harmonic("A minor", "C major")).toBe(0.9); // relative (8A ↔ 8B)
    expect(harmonic("A minor", "E minor")).toBe(0.85); // adjacent, dn=1 same (8A → 9A)
    expect(harmonic("A minor", "G minor")).toBe(0.6); // energy, dn=2 same (8A → 6A)
    expect(harmonic("A minor", "F major")).toBe(0.55); // diagonal, dn=1 diff (8A → 7B)
    expect(harmonic("A minor", "A# major")).toBe(0.35); // dn=2 diff (8A → 6B)
    expect(harmonic("A minor", "C minor")).toBe(0.25); // dn=3 (8A → 5A)
    expect(harmonic("A minor", "F minor")).toBe(0.15); // dn=4 (8A → 4A)
    expect(harmonic("A minor", "A# minor")).toBe(0.1); // dn=5 (8A → 3A)
    expect(harmonic("A minor", "D# minor")).toBe(0.05); // tritone, dn=6 (8A → 2A)
  });

  it("is symmetric and null-tolerant (missing key ⇒ null, never 0)", () => {
    expect(harmonic("E minor", "A minor")).toBe(harmonic("A minor", "E minor"));
    expect(harmonic("A minor", "H major")).toBeNull(); // unparseable
    expect(scoreMix(track({ key: null }), track({ key: "A minor" })).score).toBeNull();
  });
});

describe("bpm sub-score (band contract + curve knees)", () => {
  it("scores 1.0 within 1% and degrades linearly to the 6% and 10% knees", () => {
    expect(bpmSubScore(174, 174).score).toBe(1);
    expect(bpmSubScore(174, 175).score).toBeCloseTo(1, 5); // <1%
    // 6% knee (170 vs 180.2 ≈ 6.0%) → 0.5; 10% knee → 0.0.
    expect(bpmSubScore(170, 170 * 1.06).score).toBeCloseTo(0.5, 5);
    expect(bpmSubScore(170, 170 * 1.1).score).toBeCloseTo(0, 5);
  });

  it("scores an unbeatmatchable in-band pair (160 vs 180, 12.5%) at 0", () => {
    expect(bpmSubScore(160, 180).score).toBe(0);
  });

  it("flags an out-of-band tempo as null (never a silent octave fold)", () => {
    expect(bpmSubScore(174, 87)).toEqual({ outOfBand: true, score: null });
    expect(bpmSubScore(174, null)).toEqual({ outOfBand: false, score: null });
  });

  it("raises the pair-result flag when a BPM is out of band", () => {
    const result = scoreMix(
      track({ bpm: 87, key: "A minor" }),
      track({ bpm: 174, key: "A minor" }),
    );
    expect(result.flagged).toBe(true);
    expect(result.bpm).toBeNull();
    expect(result.score).toBe(1); // scored on key alone, at full scale
  });
});

describe("sonic sub-score (gate + affine calibration)", () => {
  it("gates on embedded-pair coverage (50 pairs ⇒ ~11 embedded findings)", () => {
    expect(sonicGateOpen(3)).toBe(false);
    expect(sonicGateOpen(10)).toBe(false); // 45 pairs
    expect(sonicGateOpen(11)).toBe(true); // 55 pairs
  });

  it("returns null below the gate even with embeddings present", () => {
    expect(sonicSubScore([1, 0], [1, 0], false)).toBeNull();
  });

  it("affinely maps cosine into [0,1] with clamping above the gate", () => {
    expect(sonicSubScore([1, 0], [1, 0], true)).toBe(1); // cos 1 → clamp01((1-0.5)/0.45)=1
    expect(sonicSubScore([1, 0], [0, 1], true)).toBe(0); // cos 0 → clamp01(<0)=0
  });
});

describe("the combiner (present-term renormalization)", () => {
  it("scores a finding on what it has, at full scale", () => {
    // Key present only ⇒ the key sub-score verbatim.
    expect(scoreMix(track({ key: "A minor" }), track({ key: "E minor" })).score).toBe(0.85);
    // Key + BPM ⇒ weighted over the present weights only.
    const both = scoreMix(track({ bpm: 174, key: "A minor" }), track({ bpm: 174, key: "E minor" }));
    const expected =
      (MIX_WEIGHTS.key * 0.85 + MIX_WEIGHTS.bpm * 1) / (MIX_WEIGHTS.key + MIX_WEIGHTS.bpm);
    expect(both.score).toBeCloseTo(expected, 10);
  });

  it("returns a null score + flag + null reason when no term is present", () => {
    const result = scoreMix(track({}), track({}));
    expect(result.score).toBeNull();
    expect(result.flagged).toBe(true);
    expect(result.reason).toBeNull();
  });
});

describe("reason selection (dominant present sub-score)", () => {
  it("names the harmonic relationship when key leads", () => {
    expect(scoreMix(track({ key: "A minor" }), track({ key: "A minor" })).reason).toEqual({
      kind: "key",
      relationship: "same_key",
    });
    expect(scoreMix(track({ key: "A minor" }), track({ key: "E minor" })).reason).toEqual({
      kind: "key",
      relationship: "adjacent",
    });
  });

  it("names tempo when BPM out-scores a weak key relation", () => {
    // Tritone key (0.05) but an identical tempo (1.0) ⇒ tempo_match dominates.
    const result = scoreMix(
      track({ bpm: 174, key: "A minor" }),
      track({ bpm: 174, key: "D# minor" }),
    );
    expect(result.reason).toEqual({ kind: "bpm", relationship: "tempo_match" });
  });

  it("names close_in_sound when the sonic term leads (gate open)", () => {
    const result = scoreMix(
      track({ embedding: [1, 0], key: "A minor" }),
      track({ embedding: [1, 0], key: "F minor" }), // weak key (0.15)
      { gateOpen: true },
    );
    expect(result.reason).toEqual({ kind: "sonic", relationship: "close_in_sound" });
  });
});

describe("the texture tiebreak (features_json)", () => {
  it("parses the fixed-order feature vector, or null", () => {
    expect(parseFeatureVector('{"centroidHz":2000,"onsetRate":4}')).toEqual([2000, 0, 0, 4, 0]);
    expect(parseFeatureVector("{}")).toBeNull();
    expect(parseFeatureVector(null)).toBeNull();
    expect(parseFeatureVector("not json")).toBeNull();
  });

  it("breaks equal-score plateaus by ascending feature distance, deterministically", () => {
    const target = track({ features: [0, 0], key: "A minor" });
    // Two candidates, IDENTICAL key relation (same_key ⇒ equal score), different texture.
    const near = track({ features: [1, 0], key: "A minor" });
    const far = track({ features: [9, 0], key: "A minor" });
    const ranked = rankMixable(
      target,
      [
        { item: "far", track: far },
        { item: "near", track: near },
      ],
      2,
    );
    expect(ranked.map((r) => r.item)).toEqual(["near", "far"]);
  });

  it("drops candidates with no scorable term", () => {
    const ranked = rankMixable(track({ key: "A minor" }), [{ item: "empty", track: track({}) }], 6);
    expect(ranked).toEqual([]);
  });

  it("computes an infinite distance when a vector is absent", () => {
    expect(featureDistance(null, [1, 2])).toBe(Number.POSITIVE_INFINITY);
    expect(featureDistance([0, 0], [3, 4])).toBe(5);
  });
});

describe("path search (the dream-weaver)", () => {
  // Four minor keys one wheel-step apart: 8A, 9A, 10A, 11A. Adjacent hops cost 0.15.
  const wheel = [
    track({ key: "A minor" }), // 0 — 8A
    track({ key: "E minor" }), // 1 — 9A
    track({ key: "B minor" }), // 2 — 10A
    track({ key: "F# minor" }), // 3 — 11A
  ];

  it("orders a small pool exactly (Held-Karp), free both endpoints", () => {
    const result = orderMixPath(wheel);
    expect(result.algorithm).toBe("held-karp");
    expect(result.totalCost).toBeCloseTo(0.45, 6); // three 0.15 hops
    expect([...result.order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    // The optimum is the wheel order (or its reverse).
    expect([result.order.join(","), [...result.order].reverse().join(",")]).toContain("0,1,2,3");
  });

  it("pins the seed as the first vertex", () => {
    const result = orderMixPath(wheel, { seedIndex: 2 });
    expect(result.order[0]).toBe(2);
    expect(result.totalCost).toBeCloseTo(0.7, 6); // C→D→B→A: 0.15 + 0.40 + 0.15
  });

  it("costs a null-pair transition at the neutral median (not max) and flags it", () => {
    const pool = [track({ key: "A minor" }), track({ key: "E minor" }), track({})];
    const result = orderMixPath(pool);
    // The lone all-null finding rides the median edge, so it is not exiled to an end.
    const transitions = transitionsAlong(result.order, pool);
    expect(transitions.some((t) => t.flagged)).toBe(true);
    expect(Number.isFinite(result.totalCost)).toBe(true);
  });

  it("is fully deterministic", () => {
    expect(orderMixPath(wheel)).toEqual(orderMixPath(wheel));
  });

  it("uses greedy + 2-opt above the Held-Karp ceiling and returns a valid permutation", () => {
    const big = Array.from({ length: 20 }, (_, i) => track({ bpm: 170 + (i % 5), key: "A minor" }));
    const result = orderMixPath(big);
    expect(result.algorithm).toBe("greedy-2opt");
    expect([...result.order].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i),
    );
  });

  it("rejects a pool outside [2, PATH_MAX]", () => {
    expect(() => orderMixPath([track({ key: "A minor" })])).toThrow(RangeError);
    expect(() =>
      orderMixPath(Array.from({ length: PATH_MAX + 1 }, () => track({ key: "A minor" }))),
    ).toThrow(RangeError);
  });
});
