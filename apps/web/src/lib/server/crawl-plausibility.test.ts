import { describe, expect, it } from "vitest";

import { creditPlausibility, yearOf } from "./crawl-plausibility";

describe("yearOf", () => {
  it("reads the leading year of any MusicBrainz date precision", () => {
    expect(yearOf("1969")).toBe(1969);
    expect(yearOf("1990-09")).toBe(1990);
    expect(yearOf("2018-10-26")).toBe(2018);
  });

  it("answers null for an absent or empty date", () => {
    expect(yearOf(null)).toBeNull();
    expect(yearOf(undefined)).toBeNull();
    expect(yearOf("")).toBeNull();
  });
});

describe("creditPlausibility", () => {
  it("flags a release two or more years older than the label's founding", () => {
    expect(
      creditPlausibility({ eraFloorYear: null, foundingYear: 2009, releaseYear: 1969 }),
    ).toEqual({
      kind: "implausible",
      reason: "before_founding",
      releaseYear: 1969,
      thresholdYear: 2009,
    });
    expect(
      creditPlausibility({ eraFloorYear: null, foundingYear: 2003, releaseYear: 2001 }).kind,
    ).toBe("implausible");
  });

  it("tolerates a release one year before the founding, where MusicBrainz dates often slip", () => {
    expect(
      creditPlausibility({ eraFloorYear: null, foundingYear: 1994, releaseYear: 1993 }),
    ).toEqual({ kind: "plausible" });
  });

  it("lets a known founding date overrule the label's stored era", () => {
    expect(
      creditPlausibility({ eraFloorYear: 2000, foundingYear: 1993, releaseYear: 1994 }),
    ).toEqual({ kind: "plausible" });
  });

  it("flags a release five or more years older than the label's stored era when no founding is known", () => {
    expect(
      creditPlausibility({ eraFloorYear: 2020, foundingYear: null, releaseYear: 2011 }),
    ).toEqual({
      kind: "implausible",
      reason: "before_label_era",
      releaseYear: 2011,
      thresholdYear: 2020,
    });
  });

  it("keeps a release within five years of the label's stored era", () => {
    expect(
      creditPlausibility({ eraFloorYear: 2020, foundingYear: null, releaseYear: 2016 }),
    ).toEqual({ kind: "plausible" });
  });

  it("stores a release with no date or no evidence about the label", () => {
    expect(
      creditPlausibility({ eraFloorYear: 2020, foundingYear: 2009, releaseYear: null }).kind,
    ).toBe("plausible");
    expect(
      creditPlausibility({ eraFloorYear: null, foundingYear: null, releaseYear: 1950 }).kind,
    ).toBe("plausible");
  });
});
