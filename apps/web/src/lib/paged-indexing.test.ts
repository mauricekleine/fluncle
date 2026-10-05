import { describe, expect, it } from "vitest";
import {
  formatHubTitleSnippet,
  formatNameList,
  formatNameRange,
  formatReleaseSpan,
} from "./paged-indexing";

describe("formatHubTitleSnippet", () => {
  it.each([
    { expected: "", names: [], order: "most" as const },
    { expected: "Calibre", names: ["Calibre"], order: "most" as const },
    { expected: "Calibre, Commix", names: ["Calibre", "Commix"], order: "most" as const },
    {
      expected: "Zebra, Anchor and more",
      names: ["Zebra", "Anchor", "Middle"],
      order: "most" as const,
    },
    {
      expected: "Zebra, Anchor and more",
      names: ["Zebra", "Anchor", "Middle"],
      order: "recent" as const,
    },
    { expected: "", names: [], order: "az" as const },
    { expected: "Calibre", names: ["Calibre"], order: "az" as const },
    { expected: "Anchor to Zebra", names: ["Anchor", "Middle", "Zebra"], order: "az" as const },
  ])(
    "formats $order page names without implying a different order: $expected",
    ({ names, order, expected }) => {
      expect(formatHubTitleSnippet(names, order)).toBe(expected);
    },
  );
});

describe("formatNameRange", () => {
  it("formats a range of two different names", () => {
    expect(formatNameRange("Calibre", "Dillinja")).toBe("Calibre to Dillinja");
  });

  it("returns just the name when first and last are the same", () => {
    expect(formatNameRange("Calibre", "Calibre")).toBe("Calibre");
  });

  it("returns empty string when either name is undefined", () => {
    expect(formatNameRange(undefined, "Dillinja")).toBe("");
    expect(formatNameRange("Calibre", undefined)).toBe("");
    expect(formatNameRange(undefined, undefined)).toBe("");
  });
});

describe("formatNameList", () => {
  it("lists names with remaining count", () => {
    expect(formatNameList(["Calibre", "Commix", "Dillinja"], 9)).toBe(
      "Calibre, Commix, Dillinja and 9 more",
    );
  });

  it("lists names without remaining when zero", () => {
    expect(formatNameList(["Calibre", "Commix"], 0)).toBe("Calibre, Commix");
  });

  it("handles a single name", () => {
    expect(formatNameList(["Calibre"], 5)).toBe("Calibre and 5 more");
  });

  it("returns empty string for empty names", () => {
    expect(formatNameList([], 0)).toBe("");
  });
});

describe("formatReleaseSpan", () => {
  it.each(["0", "2019-13", "2019-02-29", "2019-02-31"])(
    "omits non-ISO or invalid calendar dates from a release span: %s",
    (date) => {
      expect(formatReleaseSpan(date, date)).toBe("");
    },
  );

  it("formats a span across two months", () => {
    expect(formatReleaseSpan("2018-12-01", "2019-01-15")).toBe(
      "released December 2018 to January 2019",
    );
  });

  it("formats a single month when earliest and latest are in the same month", () => {
    expect(formatReleaseSpan("2019-03-01", "2019-03-28")).toBe("released March 2019");
  });

  it("formats a single date when only earliest is provided", () => {
    expect(formatReleaseSpan("2019-03-15", undefined)).toBe("released March 2019");
  });

  it("formats a single date when only latest is provided", () => {
    expect(formatReleaseSpan(undefined, "2019-03-15")).toBe("released March 2019");
  });

  it("returns empty string when both are undefined", () => {
    expect(formatReleaseSpan(undefined, undefined)).toBe("");
  });

  it("preserves year-only precision without inventing a month", () => {
    expect(formatReleaseSpan("2019", "2020")).toBe("released 2019 to 2020");
    expect(formatReleaseSpan("2019", "2019")).toBe("released 2019");
  });

  it("mixes year-only and full-precision dates", () => {
    expect(formatReleaseSpan("2019", "2020-03-15")).toBe("released 2019 to March 2020");
  });

  it("skips empty string dates", () => {
    expect(formatReleaseSpan("", "2019-03-15")).toBe("released March 2019");
    expect(formatReleaseSpan("2019-03-15", "")).toBe("released March 2019");
    expect(formatReleaseSpan("", "")).toBe("");
  });

  it("skips malformed dates that produce Invalid Date", () => {
    expect(formatReleaseSpan("not-a-date", "2019-03-15")).toBe("released March 2019");
    expect(formatReleaseSpan("2019-03-15", "garbage")).toBe("released March 2019");
    expect(formatReleaseSpan("not-a-date", "garbage")).toBe("");
  });
});
