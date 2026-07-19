import { describe, expect, it } from "vitest";
import { formatReleaseDate } from "./format";

describe("formatReleaseDate (the /tracks date column)", () => {
  it("spells out a full YYYY-MM-DD release date, long month, in UTC", () => {
    expect(formatReleaseDate("2026-07-05")).toBe("July 5, 2026");
    expect(formatReleaseDate("2024-12-22")).toBe("December 22, 2024");
    // Pinned to UTC so a midnight date never slips a day under a client's timezone.
    expect(formatReleaseDate("2026-01-01")).toBe("January 1, 2026");
  });

  it("stays honest on a partial-precision date — the YEAR alone, never a fabricated month or day", () => {
    // Spotify/MusicBrainz release_date can be year-only or year-month; `new Date("2026")` would
    // otherwise render "January 1, 2026", inventing a month and day the source never gave.
    expect(formatReleaseDate("2026")).toBe("2026");
    expect(formatReleaseDate("2026-07")).toBe("2026");
  });

  it("shows an em dash for an undated catalogue row", () => {
    expect(formatReleaseDate("")).toBe("—");
  });
});
