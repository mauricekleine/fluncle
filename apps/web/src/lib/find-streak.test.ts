import { describe, expect, it } from "vitest";
import { findStreak } from "./find-streak";

// Pure-function tests for the publish-streak. A day counts only when it carries a
// published YouTube post AND a published TikTok post. Days are bucketed in
// Europe/Amsterdam, so every fixture instant is chosen well inside an Amsterdam
// civil day (mid-afternoon UTC ≈ mid-to-late afternoon Amsterdam) to keep the
// bucketing obvious. `now` is injected so the tests don't depend on the real clock.

function pub(platform: string, publishedAt: string) {
  return { platform, publishedAt, status: "published" };
}

// A fixed "now": 2026-06-24 15:00 UTC → 24 June in Amsterdam (CEST, UTC+2).
const NOW = new Date("2026-06-24T15:00:00Z");

describe("findStreak", () => {
  it("counts consecutive days where BOTH platforms published", () => {
    const result = findStreak(
      [
        pub("youtube", "2026-06-24T10:00:00Z"),
        pub("tiktok", "2026-06-24T11:00:00Z"),
        pub("youtube", "2026-06-23T10:00:00Z"),
        pub("tiktok", "2026-06-23T11:00:00Z"),
        pub("youtube", "2026-06-22T10:00:00Z"),
        pub("tiktok", "2026-06-22T11:00:00Z"),
      ],
      NOW,
    );
    expect(result).toEqual({ days: 3, live: true });
  });

  it("breaks when a day has only one platform", () => {
    // Today has both; yesterday has only YouTube → the streak is today alone.
    const result = findStreak(
      [
        pub("youtube", "2026-06-24T10:00:00Z"),
        pub("tiktok", "2026-06-24T11:00:00Z"),
        pub("youtube", "2026-06-23T10:00:00Z"),
      ],
      NOW,
    );
    expect(result).toEqual({ days: 1, live: true });
  });

  it("does not count today when only one platform published today", () => {
    // Today: YouTube only. Yesterday: both. The streak anchors on yesterday.
    const result = findStreak(
      [
        pub("youtube", "2026-06-24T10:00:00Z"),
        pub("youtube", "2026-06-23T10:00:00Z"),
        pub("tiktok", "2026-06-23T11:00:00Z"),
      ],
      NOW,
    );
    expect(result).toEqual({ days: 1, live: true });
  });

  it("stays live and counts from yesterday when nothing published today", () => {
    const result = findStreak(
      [
        pub("youtube", "2026-06-23T10:00:00Z"),
        pub("tiktok", "2026-06-23T11:00:00Z"),
        pub("youtube", "2026-06-22T10:00:00Z"),
        pub("tiktok", "2026-06-22T11:00:00Z"),
      ],
      NOW,
    );
    expect(result).toEqual({ days: 2, live: true });
  });

  it("breaks to 0 when the most recent qualifying day is two or more days old", () => {
    const result = findStreak(
      [pub("youtube", "2026-06-22T10:00:00Z"), pub("tiktok", "2026-06-22T11:00:00Z")],
      NOW,
    );
    expect(result).toEqual({ days: 0, live: false });
  });

  it("stops at the first gap (a non-qualifying day) in the run", () => {
    const result = findStreak(
      [
        pub("youtube", "2026-06-24T10:00:00Z"),
        pub("tiktok", "2026-06-24T11:00:00Z"),
        pub("youtube", "2026-06-23T10:00:00Z"),
        pub("tiktok", "2026-06-23T11:00:00Z"),
        // gap on the 22nd — only TikTok
        pub("tiktok", "2026-06-22T11:00:00Z"),
        pub("youtube", "2026-06-21T10:00:00Z"),
        pub("tiktok", "2026-06-21T11:00:00Z"),
      ],
      NOW,
    );
    expect(result).toEqual({ days: 2, live: true });
  });

  it("collapses multiple posts per platform per day into one qualifying day", () => {
    const result = findStreak(
      [
        pub("youtube", "2026-06-24T08:00:00Z"),
        pub("youtube", "2026-06-24T20:00:00Z"),
        pub("tiktok", "2026-06-24T09:00:00Z"),
        pub("tiktok", "2026-06-24T21:00:00Z"),
      ],
      NOW,
    );
    expect(result).toEqual({ days: 1, live: true });
  });

  it("ignores non-published posts", () => {
    // Today's TikTok is only a draft → today doesn't qualify; yesterday does.
    const result = findStreak(
      [
        pub("youtube", "2026-06-24T10:00:00Z"),
        { platform: "tiktok", publishedAt: "2026-06-24T11:00:00Z", status: "draft" },
        pub("youtube", "2026-06-23T10:00:00Z"),
        pub("tiktok", "2026-06-23T11:00:00Z"),
      ],
      NOW,
    );
    expect(result).toEqual({ days: 1, live: true });
  });

  it("ignores platforms outside the required pair", () => {
    // Instagram doesn't count; today has YT + IG but no TikTok → no qualifying day.
    const result = findStreak(
      [pub("youtube", "2026-06-24T10:00:00Z"), pub("instagram", "2026-06-24T11:00:00Z")],
      NOW,
    );
    expect(result).toEqual({ days: 0, live: false });
  });

  it("returns a broken streak for an empty list", () => {
    expect(findStreak([], NOW)).toEqual({ days: 0, live: false });
  });

  it("ignores unparseable / missing timestamps", () => {
    const result = findStreak(
      [
        { platform: "youtube", status: "published" },
        pub("tiktok", "not-a-date"),
        pub("youtube", "2026-06-24T10:00:00Z"),
        pub("tiktok", "2026-06-24T11:00:00Z"),
      ],
      NOW,
    );
    expect(result).toEqual({ days: 1, live: true });
  });

  it("buckets near the Amsterdam midnight boundary, not UTC", () => {
    // 2026-06-23T22:30Z is 00:30 on the 24th in Amsterdam (CEST), so with NOW on
    // the 24th both posts count as published TODAY — a single live qualifying day.
    const result = findStreak(
      [pub("youtube", "2026-06-23T22:30:00Z"), pub("tiktok", "2026-06-23T22:45:00Z")],
      NOW,
    );
    expect(result).toEqual({ days: 1, live: true });
  });
});
