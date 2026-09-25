import { describe, expect, it } from "vitest";
import {
  applyTaste,
  bpmSubScore,
  featureDistance,
  isNamedMove,
  type MixScored,
  type MixTrack,
  MIX_PUBLIC_FLOOR,
  MIX_WEIGHTS,
  mixChainDepth,
  namedMoveClasses,
  orderMixPath,
  PATH_MAX,
  parseFeatureVector,
  railScore,
  RAIL_DEPTH,
  rankMixable,
  scoreMix,
  SET_FLOOR,
  sonicGateOpen,
  sonicSubScore,
  tasteSubScore,
  transitionsAlong,
} from "./mixability";
import { parseKey, toCamelot } from "../key-camelot";

function track(input: Partial<MixTrack>): MixTrack {
  return {
    bpm: input.bpm ?? null,
    embedding: input.embedding ?? null,
    features: input.features ?? null,
    key: input.key ?? null,
  };
}

function harmonic(keyA: string, keyB: string): number | null {
  return scoreMix(track({ key: keyA }), track({ key: keyB })).score;
}

describe("harmonic sub-score (the Camelot table)", () => {
  it("scores every documented relationship (A minor = 8A as the anchor)", () => {
    expect(harmonic("A minor", "A minor")).toBe(1.0);
    expect(harmonic("A minor", "C major")).toBe(0.9);
    expect(harmonic("A minor", "E minor")).toBe(0.85);
    expect(harmonic("A minor", "G minor")).toBe(0.6);
    expect(harmonic("A minor", "F major")).toBe(0.55);
    expect(harmonic("A minor", "A# major")).toBe(0.35);
    expect(harmonic("A minor", "C minor")).toBe(0.25);
    expect(harmonic("A minor", "F minor")).toBe(0.15);
    expect(harmonic("A minor", "A# minor")).toBe(0.1);
    expect(harmonic("A minor", "D# minor")).toBe(0.05);
  });

  it("is symmetric and null-tolerant (missing key ⇒ null, never 0)", () => {
    expect(harmonic("E minor", "A minor")).toBe(harmonic("A minor", "E minor"));
    expect(harmonic("A minor", "H major")).toBeNull();
    expect(scoreMix(track({ key: null }), track({ key: "A minor" })).score).toBeNull();
  });
});

describe("bpm sub-score (band contract + curve knees)", () => {
  it("scores 1.0 within 1% and degrades linearly to the 6% and 10% knees", () => {
    expect(bpmSubScore(174, 174).score).toBe(1);
    expect(bpmSubScore(174, 175).score).toBeCloseTo(1, 5);

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
    expect(result.score).toBe(1);
  });
});

describe("sonic sub-score (gate + affine calibration)", () => {
  it("gates on embedded-pair coverage (50 pairs ⇒ ~11 embedded findings)", () => {
    expect(sonicGateOpen(3)).toBe(false);
    expect(sonicGateOpen(10)).toBe(false);
    expect(sonicGateOpen(11)).toBe(true);
  });

  it("returns null below the gate even with embeddings present", () => {
    expect(sonicSubScore([1, 0], [1, 0], false)).toBeNull();
  });

  it("affinely maps cosine into [0,1] with clamping above the gate", () => {
    expect(sonicSubScore([1, 0], [1, 0], true)).toBe(1);
    expect(sonicSubScore([1, 0], [0, 1], true)).toBe(0);
  });
});

describe("the combiner (present-term renormalization)", () => {
  it("scores a finding on what it has, at full scale", () => {
    expect(scoreMix(track({ key: "A minor" }), track({ key: "E minor" })).score).toBe(0.85);

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
    const result = scoreMix(
      track({ bpm: 174, key: "A minor" }),
      track({ bpm: 174, key: "D# minor" }),
    );
    expect(result.reason).toEqual({ kind: "bpm", relationship: "tempo_match" });
  });

  it("names close_in_sound when the sonic term leads (gate open)", () => {
    const result = scoreMix(
      track({ embedding: [1, 0], key: "A minor" }),
      track({ embedding: [1, 0], key: "F minor" }),
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
  const wheel = [
    track({ key: "A minor" }),
    track({ key: "E minor" }),
    track({ key: "B minor" }),
    track({ key: "F# minor" }),
  ];

  it("orders a small pool exactly (Held-Karp), free both endpoints", () => {
    const result = orderMixPath(wheel);
    expect(result.algorithm).toBe("held-karp");
    expect(result.totalCost).toBeCloseTo(0.45, 6);
    expect([...result.order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);

    expect([result.order.join(","), [...result.order].reverse().join(",")]).toContain("0,1,2,3");
  });

  it("pins the seed as the first vertex", () => {
    const result = orderMixPath(wheel, { seedIndex: 2 });
    expect(result.order[0]).toBe(2);
    expect(result.totalCost).toBeCloseTo(0.7, 6);
  });

  it("costs a null-pair transition at the neutral median (not max) and flags it", () => {
    const pool = [track({ key: "A minor" }), track({ key: "E minor" }), track({})];
    const result = orderMixPath(pool);

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

describe("the key floor — a data-poor row can never win the rail (regression)", () => {
  const identical = Array.from({ length: 8 }, () => 0.35355339059327373);

  it("an unkeyed pair with a perfect embedding is UNRANKABLE, not a perfect score", () => {
    const result = scoreMix(track({ embedding: identical }), track({ embedding: identical }), {
      gateOpen: true,
    });

    expect(result.score).toBeNull();
    expect(result.flagged).toBe(true);
  });

  it("a fully-measured good match OUTRANKS the data-poor row", () => {
    const measured = scoreMix(
      track({ bpm: 174, embedding: identical, key: "A minor" }),
      track({ bpm: 174, embedding: identical, key: "A minor" }),
      { gateOpen: true },
    );
    const dataPoor = scoreMix(track({ embedding: identical }), track({ embedding: identical }), {
      gateOpen: true,
    });

    expect(measured.score).not.toBeNull();
    expect(dataPoor.score).toBeNull();

    const ranked = rankMixable(
      track({ bpm: 174, embedding: identical, key: "A minor" }),
      [
        { item: "data-poor", track: track({ embedding: identical }) },
        { item: "measured", track: track({ bpm: 174, embedding: identical, key: "A minor" }) },
      ],
      5,
      { gateOpen: true },
    );

    expect(ranked.map((row) => row.item)).toEqual(["measured"]);
  });

  it("a keyed pair with a missing bpm still ranks (the floor is the KEY, not completeness)", () => {
    const result = scoreMix(
      track({ embedding: identical, key: "A minor" }),
      track({ embedding: identical, key: "A minor" }),
      { gateOpen: true },
    );

    expect(result.score).not.toBeNull();
  });
});

describe("named moves (the harmonic adjacency the rail pre-filters on)", () => {
  const camelot = (key: string) => {
    const parsed = parseKey(key);

    if (!parsed) {
      throw new Error(`unparseable test key: ${key}`);
    }

    return toCamelot(parsed);
  };

  it("names same-key, relative, adjacent, diagonal, and energy as moves", () => {
    const a = camelot("A minor");

    expect(isNamedMove(a, camelot("A minor"))).toBe(true);
    expect(isNamedMove(a, camelot("C major"))).toBe(true);
    expect(isNamedMove(a, camelot("E minor"))).toBe(true);
    expect(isNamedMove(a, camelot("G major"))).toBe(true);
    expect(isNamedMove(a, camelot("G minor"))).toBe(true);
  });

  it("rejects a distant key (a tritone is not a move a DJ makes)", () => {
    expect(isNamedMove(camelot("A minor"), camelot("D# minor"))).toBe(false);
  });

  it("reaches exactly 8 of the 24 Camelot classes (itself + 7 named moves)", () => {
    const classes = namedMoveClasses(camelot("A minor"));

    expect(classes).toHaveLength(8);

    const codes = new Set(classes.map(({ letter, number }) => `${number}${letter}`));
    expect(codes.size).toBe(8);
    expect(classes.every((to) => isNamedMove(camelot("A minor"), to))).toBe(true);
  });
});

describe("the depth gate (mixChainDepth)", () => {
  it("is closed on an empty archive, and rankable is 0", () => {
    const depth = mixChainDepth([]);

    expect(depth).toEqual({ median: 0, open: false, rankable: 0 });
  });

  it("counts only parseable keys as rankable", () => {
    const depth = mixChainDepth([
      { count: 5, key: "A minor" },
      { count: 3, key: "not a key" },
      { count: 2, key: null },
    ]);

    expect(depth.rankable).toBe(5);
  });

  it("folds enharmonic spellings onto one Camelot class before measuring", () => {
    const depth = mixChainDepth([
      { count: 2, key: "A# minor" },
      { count: 2, key: "Bb minor" },
    ]);

    expect(depth.rankable).toBe(4);
    expect(depth.median).toBe(3);
  });

  it("opens once the median track can reach the floor by a named move", () => {
    const histogram = Array.from({ length: 12 }, (_, index) => ({
      count: 40,
      key: `${["A", "A#", "B", "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#"][index]} minor`,
    }));
    const depth = mixChainDepth(histogram);

    expect(depth.open).toBe(true);
    expect(depth.median).toBeGreaterThanOrEqual(MIX_PUBLIC_FLOOR);
  });

  it("stays closed when the archive is deep in count but thin in the median neighbourhood", () => {
    const depth = mixChainDepth([
      { count: 8, key: "A minor" },
      { count: 8, key: "D# minor" },
    ]);

    expect(depth.median).toBe(7);
    expect(depth.open).toBe(false);
  });

  it("the floor is one of Fluncle's own sets plus a full rail (not a picked number)", () => {
    expect(MIX_PUBLIC_FLOOR).toBe(SET_FLOOR + RAIL_DEPTH);
  });
});

describe("taste (the seed combiner)", () => {
  it("is null for a candidate with no vector to compare", () => {
    expect(tasteSubScore(null)).toBeNull();
  });

  it("calibrates a cosine onto [0,1] the same way the sonic term does", () => {
    expect(tasteSubScore(0.95)).toBeCloseTo(1, 5);
    expect(tasteSubScore(0.5)).toBeCloseTo(0, 5);
  });

  it("railScore degrades to plain mixability when taste is absent", () => {
    expect(railScore(0.8, null)).toBe(0.8);
  });

  it("railScore is a product, so a hated track cannot outrank a loved clean mix", () => {
    expect(railScore(0.95, 0.1)).toBeLessThan(railScore(0.7, 0.9));
  });
});

describe("applyTaste (re-ranking a shortlist by mixability × taste)", () => {
  const shortlist: MixScored<string>[] = [
    { item: "clean-but-off-lane", reason: { kind: "key", relationship: "same_key" }, score: 0.95 },
    { item: "good-and-on-lane", reason: { kind: "key", relationship: "adjacent" }, score: 0.7 },
  ];

  it("promotes the on-lane candidate above the cleaner off-lane one", () => {
    const ranked = applyTaste(shortlist, (item) => (item === "good-and-on-lane" ? 0.95 : 0.5), 2);

    expect(ranked.map((row) => row.item)).toEqual(["good-and-on-lane", "clean-but-off-lane"]);
  });

  it("keeps a candidate with no taste measurement on its mixability rank (never punished)", () => {
    const ranked = applyTaste(shortlist, () => null, 2);

    expect(ranked[0]?.item).toBe("clean-but-off-lane");
  });

  it("cuts to the limit and returns nothing for a non-positive limit", () => {
    expect(applyTaste(shortlist, () => 0.9, 1)).toHaveLength(1);
    expect(applyTaste(shortlist, () => 0.9, 0)).toEqual([]);
  });
});
