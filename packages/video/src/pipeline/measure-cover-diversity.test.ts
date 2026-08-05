import { describe, expect, test } from "bun:test";

import { type RgbImage } from "./frames";
import { type DiversityFeature, DIVERSITY_MIN } from "./judge-diversity";
import {
  bucketHistogram,
  type CoverSample,
  countEchoingPairs,
  coverPaletteOf,
  coverPairs,
  dominantSwatches,
  formatCoverReport,
  summarizeCoverCorpus,
} from "./measure-cover-diversity";

/** A feature whose histograms sit on one bin — two samples on the SAME bin read as
 *  identical (distance 0), on disjoint bins as maximally distinct (distance 1). */
function feature(bin: number, luma = 0.5, size = 9): DiversityFeature {
  const color = new Float32Array(size);
  const edge = new Float32Array(size);
  color[bin] = 1;
  edge[bin] = 1;
  return { colorHist: color, edgeOrient: edge, lumaMean: luma, lumaStd: luma };
}

function sample(logId: string, bin: number, luma = 0.5): CoverSample {
  return {
    feature: feature(bin, luma),
    logId,
    palette: { bucket: "neutral-mono", swatches: [] },
  };
}

/** A solid-colour image, the smallest thing the palette extractor can be pinned on. */
function solid(hexTriples: [number, number, number][], width = 4): RgbImage {
  const height = hexTriples.length;
  const data = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 3;
      data[p] = hexTriples[y][0];
      data[p + 1] = hexTriples[y][1];
      data[p + 2] = hexTriples[y][2];
    }
  }
  return { data, height, width };
}

describe("coverPairs", () => {
  test("enumerates every unordered pair once, in corpus order", () => {
    const pairs = coverPairs([sample("a", 0), sample("b", 1), sample("c", 2)]);
    expect(pairs.map((p) => `${p.a}${p.b}`)).toEqual(["ab", "ac", "bc"]);
  });

  test("n samples produce n(n−1)/2 pairs", () => {
    const samples = ["a", "b", "c", "d", "e"].map((id, i) => sample(id, i));
    expect(coverPairs(samples)).toHaveLength(10);
  });

  test("a single cover has nothing to compare against", () => {
    expect(coverPairs([sample("a", 0)])).toHaveLength(0);
    expect(coverPairs([])).toHaveLength(0);
  });

  test("identical features read distance 0; disjoint ones read the edge+colour weight", () => {
    const twins = coverPairs([sample("a", 0), sample("b", 0)]);
    expect(twins[0].distance.combined).toBeCloseTo(0);
    // Disjoint histograms with equal luma: edge 1 × 0.60 + colour 1 × 0.20 + luma 0.
    const distinct = coverPairs([sample("a", 0), sample("b", 4)]);
    expect(distinct[0].distance.combined).toBeCloseTo(0.8);
  });
});

describe("countEchoingPairs", () => {
  test("counts only pairs strictly under the reference line", () => {
    const pairs = coverPairs([sample("a", 0), sample("b", 0), sample("c", 4)]);
    // a↔b are twins (0); a↔c and b↔c are disjoint (0.8).
    expect(countEchoingPairs(pairs)).toBe(1);
  });

  test("nothing echoes in a fully distinct corpus", () => {
    const pairs = coverPairs([sample("a", 0), sample("b", 3), sample("c", 6)]);
    expect(countEchoingPairs(pairs)).toBe(0);
  });

  test("defaults to the poster-calibrated DIVERSITY_MIN and honours an override", () => {
    const pairs = coverPairs([sample("a", 0), sample("b", 4)]);
    expect(countEchoingPairs(pairs)).toBe(0);
    expect(countEchoingPairs(pairs, DIVERSITY_MIN)).toBe(0);
    // A line above every possible distance catches everything.
    expect(countEchoingPairs(pairs, 1.5)).toBe(1);
  });
});

describe("summarizeCoverCorpus", () => {
  test("reports mean, min, max and the most-similar pairs closest first", () => {
    const report = summarizeCoverCorpus([sample("a", 0), sample("b", 0), sample("c", 4)], {
      top: 2,
    });
    expect(report.measured).toBe(3);
    expect(report.pairs).toBe(3);
    expect(report.minDistance).toBeCloseTo(0);
    expect(report.maxDistance).toBeCloseTo(0.8);
    expect(report.meanDistance).toBeCloseTo(1.6 / 3);
    // Two of three pairs are disjoint on both histograms; luma is constant across the corpus.
    expect(report.meanEdge).toBeCloseTo(2 / 3);
    expect(report.meanColor).toBeCloseTo(2 / 3);
    expect(report.meanLuma).toBeCloseTo(0);
    expect(report.worst).toHaveLength(2);
    expect(`${report.worst[0].a}${report.worst[0].b}`).toBe("ab");
    expect(report.echoingPairs).toBe(1);
    expect(report.echoThreshold).toBe(DIVERSITY_MIN);
  });

  test("an empty corpus reports null distances rather than a fabricated zero", () => {
    const report = summarizeCoverCorpus([]);
    expect(report.pairs).toBe(0);
    expect(report.meanDistance).toBeNull();
    expect(report.minDistance).toBeNull();
    expect(report.maxDistance).toBeNull();
    expect(report.meanEdge).toBeNull();
    expect(report.worst).toEqual([]);
  });

  test("carries the offered count and the unresolved coordinates through", () => {
    const report = summarizeCoverCorpus([sample("a", 0)], {
      offered: 4,
      unreachable: ["x", "y", "z"],
    });
    expect(report.measured).toBe(1);
    expect(report.offered).toBe(4);
    expect(report.unreachable).toEqual(["x", "y", "z"]);
  });

  test("the palette spread counts defining buckets and every dominant swatch", () => {
    const report = summarizeCoverCorpus([
      {
        feature: feature(0),
        logId: "a",
        palette: { bucket: "amber-warm", swatches: ["#ff9900", "#101010"] },
      },
      {
        feature: feature(1),
        logId: "b",
        palette: { bucket: "amber-warm", swatches: ["#ffaa22"] },
      },
    ]);
    const defining = new Map(report.buckets.map((b) => [b.bucket, b.n]));
    expect(defining.get("amber-warm")).toBe(2);
    expect(defining.get("teal-cool")).toBe(0);
    const swatches = new Map(report.swatchBuckets.map((b) => [b.bucket, b.n]));
    expect(swatches.get("amber-warm")).toBe(2);
    expect(swatches.get("neutral-mono")).toBe(1);
  });
});

describe("bucketHistogram", () => {
  test("keeps the closed vocabulary's order and its zeros", () => {
    const hist = bucketHistogram(["teal-cool", "teal-cool", "red-hot"]);
    expect(hist).toHaveLength(9);
    expect(hist[0]).toEqual({ bucket: "red-hot", n: 1 });
    expect(hist.find((h) => h.bucket === "teal-cool")?.n).toBe(2);
    expect(hist.find((h) => h.bucket === "indigo-cool")?.n).toBe(0);
  });
});

describe("dominantSwatches / coverPaletteOf", () => {
  test("returns the most frequent colours first", () => {
    // Three rows of orange, one of blue.
    const img = solid([
      [255, 153, 0],
      [255, 153, 0],
      [255, 153, 0],
      [0, 60, 255],
    ]);
    const swatches = dominantSwatches(img, 2);
    expect(swatches).toHaveLength(2);
    expect(swatches[0]).toBe("#ff9900");
    expect(swatches[1]).toBe("#003cff");
  });

  test("the DEFINING bucket is the most chromatic swatch, not the most frequent", () => {
    // A cover that is mostly near-black field with one saturated teal accent.
    const img = solid([
      [6, 6, 8],
      [6, 6, 8],
      [6, 6, 8],
      [0, 200, 190],
    ]);
    const palette = coverPaletteOf(img);
    expect(palette.swatches[0]).toBe("#060608");
    expect(palette.bucket).toBe("teal-cool");
  });

  test("an all-neutral cover buckets neutral-mono", () => {
    const palette = coverPaletteOf(
      solid([
        [10, 10, 10],
        [20, 20, 20],
      ]),
    );
    expect(palette.bucket).toBe("neutral-mono");
  });
});

describe("formatCoverReport", () => {
  const report = summarizeCoverCorpus(
    [
      {
        feature: feature(0),
        logId: "001.0.0A",
        palette: { bucket: "amber-warm", swatches: ["#ff9900"] },
      },
      {
        feature: feature(0),
        logId: "002.0.0B",
        palette: { bucket: "amber-warm", swatches: ["#ffaa22"] },
      },
      {
        feature: feature(4),
        logId: "003.0.0C",
        palette: { bucket: "teal-cool", swatches: ["#00c8be"] },
      },
    ],
    { offered: 4, top: 2, unreachable: ["004.0.0D"] },
  );
  const markdown = formatCoverReport(report);

  test("leads with the corpus counts", () => {
    expect(markdown).toContain("# Cover diversity — whole-corpus measurement");
    expect(markdown).toContain("covers measured: **3** of 4 findings offered");
    expect(markdown).toContain("pairs compared: **3**");
    expect(markdown).toContain("unresolved covers: 1 (004.0.0D)");
  });

  test("states the distances to three decimals", () => {
    expect(markdown).toContain("- mean: **0.533**");
    expect(markdown).toContain("- min: **0.000**");
    expect(markdown).toContain("- max: **0.800**");
    expect(markdown).toContain("edge 0.667 · colour 0.667 · luma 0.000");
  });

  test("names the most-similar pairs by coordinate", () => {
    expect(markdown).toContain("## The 2 most-similar pairs");
    expect(markdown).toContain("| 001.0.0A ↔ 002.0.0B | 0.000 |");
  });

  test("counts echoing pairs and cites the poster calibration as a reference line", () => {
    expect(markdown).toContain(`**1** of 3 pairs sit under ${DIVERSITY_MIN}`);
    expect(markdown).toContain("calibrated on POSTERS");
    expect(markdown).toContain("never as a verdict");
  });

  test("tabulates the palette spread over the closed vocabulary", () => {
    expect(markdown).toContain("| amber-warm | 2 | 2 |");
    expect(markdown).toContain("| teal-cool | 1 | 1 |");
    expect(markdown).toContain("| magenta-cool | 0 | 0 |");
  });

  test("an empty corpus formats as n/a rather than throwing", () => {
    const empty = formatCoverReport(summarizeCoverCorpus([]));
    expect(empty).toContain("- mean: **n/a**");
    expect(empty).toContain("covers measured: **0** of 0 findings offered");
  });
});
