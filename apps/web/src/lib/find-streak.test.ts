import { describe, expect, it } from "vitest";
import { findStreak } from "./find-streak";

// Pure-function tests for the find-streak. Days are bucketed in Europe/Amsterdam,
// so every fixture instant is chosen well inside an Amsterdam civil day (mid-
// afternoon UTC ≈ mid-to-late afternoon Amsterdam) to keep the bucketing obvious.
// `now` is injected so the tests don't depend on the real clock.

function find(addedAt: string) {
  return { addedAt };
}

// A fixed "now": 2026-06-24 15:00 UTC → 24 June in Amsterdam (CEST, UTC+2).
const NOW = new Date("2026-06-24T15:00:00Z");

describe("findStreak", () => {
  it("counts consecutive days back from today", () => {
    const result = findStreak(
      [find("2026-06-24T10:00:00Z"), find("2026-06-23T10:00:00Z"), find("2026-06-22T10:00:00Z")],
      NOW,
    );
    expect(result).toEqual({ days: 3, live: true });
  });

  it("stays live and counts from yesterday when there is no find today", () => {
    const result = findStreak([find("2026-06-23T10:00:00Z"), find("2026-06-22T10:00:00Z")], NOW);
    expect(result).toEqual({ days: 2, live: true });
  });

  it("breaks to 0 when the most recent find is two or more days old", () => {
    const result = findStreak([find("2026-06-22T10:00:00Z")], NOW);
    expect(result).toEqual({ days: 0, live: false });
  });

  it("collapses multiple finds on the same day into one streak day", () => {
    const result = findStreak(
      [find("2026-06-24T08:00:00Z"), find("2026-06-24T20:00:00Z"), find("2026-06-23T10:00:00Z")],
      NOW,
    );
    expect(result).toEqual({ days: 2, live: true });
  });

  it("stops at the first gap in the run", () => {
    const result = findStreak(
      [
        find("2026-06-24T10:00:00Z"),
        find("2026-06-23T10:00:00Z"),
        // gap on the 22nd
        find("2026-06-21T10:00:00Z"),
      ],
      NOW,
    );
    expect(result).toEqual({ days: 2, live: true });
  });

  it("returns a broken streak for an empty list", () => {
    expect(findStreak([], NOW)).toEqual({ days: 0, live: false });
  });

  it("ignores unparseable timestamps", () => {
    const result = findStreak(
      [find("not-a-date"), find("2026-06-24T10:00:00Z"), find("2026-06-23T10:00:00Z")],
      NOW,
    );
    expect(result).toEqual({ days: 2, live: true });
  });

  it("buckets near the Amsterdam midnight boundary, not UTC", () => {
    // 2026-06-23T22:30Z is 00:30 on the 24th in Amsterdam (CEST), so with NOW on
    // the 24th this counts as a find TODAY — a single live day, not a break.
    const result = findStreak([find("2026-06-23T22:30:00Z")], NOW);
    expect(result).toEqual({ days: 1, live: true });
  });
});
