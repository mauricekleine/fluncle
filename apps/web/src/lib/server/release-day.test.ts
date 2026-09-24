import { describe, expect, it } from "vitest";
import { isUpcomingRelease, releaseTodayUtc, releaseWindowLowerBound } from "./release-day";

describe("release day", () => {
  it("uses the UTC date at the instant", () => {
    expect(releaseTodayUtc(new Date("2026-09-30T23:59:59Z"))).toBe("2026-09-30");
    expect(releaseTodayUtc(new Date("2026-10-01T00:00:00Z"))).toBe("2026-10-01");
  });

  it("holds full dates only until their day starts", () => {
    expect(isUpcomingRelease("2026-10-02", "2026-10-01")).toBe(true);
    expect(isUpcomingRelease("2026-10-01", "2026-10-01")).toBe(false);
  });

  it("releases partial dates at the start of their period", () => {
    expect(isUpcomingRelease("2027", "2026-10-01")).toBe(true);
    expect(isUpcomingRelease("2026", "2026-01-01")).toBe(false);
    expect(isUpcomingRelease("2026-11", "2026-10-31")).toBe(true);
    expect(isUpcomingRelease("2026-10", "2026-10-01")).toBe(false);
  });

  it("retains undated tracks", () => {
    expect(isUpcomingRelease(null, "2026-10-01")).toBe(false);
    expect(isUpcomingRelease("", "2026-10-01")).toBe(false);
    expect(isUpcomingRelease("20x?long", "2026-10-01")).toBe(false);
  });

  it("includes month and year precision on a window's first day", () => {
    expect(releaseWindowLowerBound("2026-10-01")).toBe("2026-10");
    expect(releaseWindowLowerBound("2026-01-01")).toBe("2026");
    expect(releaseWindowLowerBound("2026-10-02")).toBe("2026-10-02");
  });
});
