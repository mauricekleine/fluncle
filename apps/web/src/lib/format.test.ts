import { describe, expect, it } from "vitest";
import { formatReleaseDate, formatReleaseDayRange } from "./format";

describe("formatReleaseDate (the /tracks date column)", () => {
  it("formats a full YYYY-MM-DD release date in the canon short-month form, in UTC", () => {
    expect(formatReleaseDate("2026-07-05")).toBe("Jul 5, 2026");
    expect(formatReleaseDate("2024-12-22")).toBe("Dec 22, 2024");

    expect(formatReleaseDate("2026-01-01")).toBe("Jan 1, 2026");
  });

  it("stays honest on a partial-precision date — the YEAR alone, never a fabricated month or day", () => {
    expect(formatReleaseDate("2026")).toBe("2026");
    expect(formatReleaseDate("2026-07")).toBe("2026");
  });

  it("shows an em dash for an undated catalogue row", () => {
    expect(formatReleaseDate("")).toBe("—");
  });
});

describe("formatReleaseDayRange (the /fresh week spans)", () => {
  const withoutRangeSpacing = (value: string): string => value.replace(/\s*–\s*/u, "–");

  it("collapses a span the way the locale collapses a range", () => {
    expect(withoutRangeSpacing(formatReleaseDayRange("2026-09-05", "2026-09-11"))).toBe(
      "Sep 5–11, 2026",
    );
    expect(withoutRangeSpacing(formatReleaseDayRange("2026-08-29", "2026-09-04"))).toBe(
      "Aug 29–Sep 4, 2026",
    );
    expect(withoutRangeSpacing(formatReleaseDayRange("2025-12-29", "2026-01-04"))).toBe(
      "Dec 29, 2025–Jan 4, 2026",
    );
  });

  it("reads a single day as that day", () => {
    expect(formatReleaseDayRange("2026-09-05", "2026-09-05")).toBe("Sep 5, 2026");
  });

  it("falls back to the end's own release-date form when either end is not a full day", () => {
    expect(formatReleaseDayRange("2026-09", "2026-09-11")).toBe("Sep 11, 2026");
    expect(formatReleaseDayRange("2026-09-01", "2026")).toBe("2026");
  });
});
