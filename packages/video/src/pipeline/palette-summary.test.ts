import { describe, expect, test } from "bun:test";

import { hueBucketOf, parseHex, rgbToHsv, summarizePalette } from "./palette-summary";

describe("parseHex", () => {
  test("parses #rrggbb", () => {
    expect(parseHex("#ff8000")).toEqual([1, 128 / 255, 0]);
  });
  test("parses shorthand #rgb", () => {
    expect(parseHex("#f80")).toEqual([1, 136 / 255, 0]);
  });
  test("tolerates a missing hash", () => {
    expect(parseHex("ff8000")).not.toBeNull();
  });
  test("rejects garbage", () => {
    expect(parseHex("not-a-color")).toBeNull();
    expect(parseHex("#12")).toBeNull();
  });
});

describe("rgbToHsv", () => {
  test("pure red is hue 0", () => {
    expect(rgbToHsv(1, 0, 0).h).toBeCloseTo(0);
  });
  test("amber/gold lands ~40°", () => {
    const { h } = rgbToHsv(1, 170 / 255, 0);
    expect(h).toBeGreaterThan(30);
    expect(h).toBeLessThan(45);
  });
  test("grey has zero saturation", () => {
    expect(rgbToHsv(0.5, 0.5, 0.5).s).toBe(0);
  });
});

describe("hueBucketOf", () => {
  test("Eclipse-Gold amber buckets amber-warm", () => {
    expect(hueBucketOf("#e8a94b")).toBe("amber-warm");
  });
  test("a hot red buckets red-hot", () => {
    expect(hueBucketOf("#e23b2b")).toBe("red-hot");
  });
  test("a teal buckets teal-cool", () => {
    expect(hueBucketOf("#1fa89a")).toBe("teal-cool");
  });
  test("a blue buckets blue-cool", () => {
    expect(hueBucketOf("#3b5fe2")).toBe("blue-cool");
  });
  test("a near-black warm-dark field is neutral-mono", () => {
    expect(hueBucketOf("#0b0a10")).toBe("neutral-mono");
  });
  test("cream/near-white is neutral-mono (below the chroma floor)", () => {
    expect(hueBucketOf("#f4ead7")).toBe("neutral-mono");
  });
  test("is deterministic", () => {
    expect(hueBucketOf("#e8a94b")).toBe(hueBucketOf("#e8a94b"));
  });
});

describe("summarizePalette", () => {
  test("the amber attractor palette summarizes to amber-warm", () => {
    // A warm-dark ground, gold accent+glow, cream ink — the 07-13 basin.
    const summary = summarizePalette({
      accent: "#e8a94b",
      background: "#171208",
      glow: "#f2c976",
      ink: "#f4ead7",
    });
    expect(summary.bucket).toBe("amber-warm");
    expect(summary.swatches.length).toBeGreaterThanOrEqual(2);
    expect(summary.swatches).toContain("#e8a94b");
  });

  test("the defining bucket comes from the more chromatic of accent/glow", () => {
    // A near-grey accent but a saturated teal glow → teal-cool.
    const summary = summarizePalette({
      accent: "#888888",
      background: "#101012",
      glow: "#12b3a2",
    });
    expect(summary.bucket).toBe("teal-cool");
  });

  test("an all-neutral palette is neutral-mono", () => {
    const summary = summarizePalette({
      accent: "#3a3a3a",
      background: "#0b0a10",
      glow: "#5a5a5a",
    });
    expect(summary.bucket).toBe("neutral-mono");
  });

  test("dedupes and normalizes swatches", () => {
    const summary = summarizePalette({
      accent: "#E8A94B",
      background: "#e8a94b",
      glow: "#f2c976",
    });
    // accent and background are the same colour (case-insensitive) → one entry.
    expect(summary.swatches.filter((s) => s === "#e8a94b").length).toBe(1);
  });
});
