import { describe, expect, it } from "vitest";
import { formatReleaseDate } from "./format";

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
