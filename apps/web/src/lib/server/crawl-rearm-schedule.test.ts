import { describe, expect, it } from "vitest";

import {
  mostRecentSeedRearmBoundary,
  type RearmBoundary,
  SEED_REARM_SCHEDULE,
} from "./crawl-rearm-schedule";

/** The boundary for an instant, as an ISO string — the shape `rearmSeedLabels` actually binds. */
function boundaryOf(iso: string): string {
  return mostRecentSeedRearmBoundary(new Date(iso)).toISOString();
}

describe("the release-week schedule", () => {
  it("is three UTC passes: Friday noon, Sunday midnight, Tuesday midnight", () => {
    expect([...SEED_REARM_SCHEDULE]).toEqual([
      { hourUtc: 12, weekday: 5 },
      { hourUtc: 0, weekday: 0 },
      { hourUtc: 0, weekday: 2 },
    ]);
  });

  it("every entry is a real weekday and a real hour", () => {
    for (const boundary of SEED_REARM_SCHEDULE) {
      expect(Number.isInteger(boundary.weekday)).toBe(true);
      expect(boundary.weekday).toBeGreaterThanOrEqual(0);
      expect(boundary.weekday).toBeLessThanOrEqual(6);
      expect(Number.isInteger(boundary.hourUtc)).toBe(true);
      expect(boundary.hourUtc).toBeGreaterThanOrEqual(0);
      expect(boundary.hourUtc).toBeLessThanOrEqual(23);
    }
  });
});

describe("mostRecentSeedRearmBoundary", () => {
  // A fixed reference week, so every case reads as a calendar rather than an offset:
  // 2026-09-14 is a Monday, so Tue 15th, Fri 18th, Sun 20th, Tue 22nd, Fri 25th.

  it("returns the boundary itself when now is exactly on one", () => {
    expect(boundaryOf("2026-09-18T12:00:00.000Z")).toBe("2026-09-18T12:00:00.000Z");
    expect(boundaryOf("2026-09-20T00:00:00.000Z")).toBe("2026-09-20T00:00:00.000Z");
    expect(boundaryOf("2026-09-22T00:00:00.000Z")).toBe("2026-09-22T00:00:00.000Z");
  });

  it("holds the previous boundary one millisecond before a new one opens", () => {
    // A hair before Friday noon still belongs to Tuesday's pass.
    expect(boundaryOf("2026-09-18T11:59:59.999Z")).toBe("2026-09-15T00:00:00.000Z");
    // A hair before Sunday midnight still belongs to Friday's.
    expect(boundaryOf("2026-09-19T23:59:59.999Z")).toBe("2026-09-18T12:00:00.000Z");
    // A hair before Tuesday midnight still belongs to Sunday's.
    expect(boundaryOf("2026-09-21T23:59:59.999Z")).toBe("2026-09-20T00:00:00.000Z");
  });

  it("moves to the new boundary one millisecond after it opens", () => {
    expect(boundaryOf("2026-09-18T12:00:00.001Z")).toBe("2026-09-18T12:00:00.000Z");
    expect(boundaryOf("2026-09-20T00:00:00.001Z")).toBe("2026-09-20T00:00:00.000Z");
    expect(boundaryOf("2026-09-22T00:00:00.001Z")).toBe("2026-09-22T00:00:00.000Z");
  });

  it("wraps across the week's longest gap (Tuesday → Friday)", () => {
    // The 3.5-day stretch: Tuesday's pass holds all the way to Friday noon, weekday by weekday.
    for (const iso of [
      "2026-09-15T00:00:00.000Z", // Tue, on the boundary
      "2026-09-15T23:00:00.000Z", // Tue night
      "2026-09-16T08:30:00.000Z", // Wed
      "2026-09-17T19:45:00.000Z", // Thu
      "2026-09-18T00:00:00.000Z", // Fri midnight — the weekday has arrived, the hour has not
      "2026-09-18T11:00:00.000Z", // Fri morning
    ]) {
      expect(boundaryOf(iso)).toBe("2026-09-15T00:00:00.000Z");
    }
  });

  it("covers the Friday→Sunday and Sunday→Tuesday gaps the same way", () => {
    expect(boundaryOf("2026-09-18T12:00:01.000Z")).toBe("2026-09-18T12:00:00.000Z");
    expect(boundaryOf("2026-09-19T13:00:00.000Z")).toBe("2026-09-18T12:00:00.000Z");
    expect(boundaryOf("2026-09-20T09:00:00.000Z")).toBe("2026-09-20T00:00:00.000Z");
    expect(boundaryOf("2026-09-21T12:00:00.000Z")).toBe("2026-09-20T00:00:00.000Z");
  });

  it("crosses a month and a year boundary without a special case", () => {
    // 2026-10-01 is a Thursday: the previous pass is Tuesday the 29th of September.
    expect(boundaryOf("2026-10-01T06:00:00.000Z")).toBe("2026-09-29T00:00:00.000Z");
    // 2027-01-01 is a Friday: before noon, the pass is Tuesday 2026-12-29.
    expect(boundaryOf("2027-01-01T09:00:00.000Z")).toBe("2026-12-29T00:00:00.000Z");
    expect(boundaryOf("2027-01-01T12:00:00.000Z")).toBe("2027-01-01T12:00:00.000Z");
  });

  it("is UTC only, so a DST shift in any local zone moves nothing", () => {
    // Europe/Amsterdam ends summer time on 2026-10-25, a Sunday, at 03:00 local. The Sunday pass
    // sits at 00:00 UTC either side of it and the whole week reads identically in UTC.
    expect(boundaryOf("2026-10-25T00:00:00.000Z")).toBe("2026-10-25T00:00:00.000Z");
    expect(boundaryOf("2026-10-25T01:30:00.000Z")).toBe("2026-10-25T00:00:00.000Z");
    // The same instant expressed with a local offset resolves to the same boundary.
    expect(boundaryOf("2026-10-25T03:30:00.000+02:00")).toBe("2026-10-25T00:00:00.000Z");
    // And the spring shift (2026-03-29, also a Sunday) behaves the same.
    expect(boundaryOf("2026-03-29T02:00:00.000Z")).toBe("2026-03-29T00:00:00.000Z");
  });

  it("never returns a future instant, at any minute of a whole week", () => {
    const start = Date.parse("2026-09-14T00:00:00.000Z");
    for (let minute = 0; minute < 7 * 24 * 60; minute += 1) {
      const now = new Date(start + minute * 60_000);
      const boundary = mostRecentSeedRearmBoundary(now);
      expect(boundary.getTime()).toBeLessThanOrEqual(now.getTime());
      // And never further back than the widest gap in the schedule (Tue 00:00 → Fri 12:00).
      expect(now.getTime() - boundary.getTime()).toBeLessThan(3.5 * 24 * 60 * 60 * 1000 + 60_000);
    }
  });

  it("lands on a scheduled weekday and hour, on the dot, at any minute of a week", () => {
    const start = Date.parse("2026-09-14T00:00:00.000Z");
    const scheduled = new Set(
      SEED_REARM_SCHEDULE.map((entry) => `${entry.weekday}:${entry.hourUtc}`),
    );
    for (let minute = 0; minute < 7 * 24 * 60; minute += 7) {
      const boundary = mostRecentSeedRearmBoundary(new Date(start + minute * 60_000));
      expect(scheduled.has(`${boundary.getUTCDay()}:${boundary.getUTCHours()}`)).toBe(true);
      expect(boundary.getUTCMinutes()).toBe(0);
      expect(boundary.getUTCSeconds()).toBe(0);
      expect(boundary.getUTCMilliseconds()).toBe(0);
    }
  });

  it("reads the schedule as data — a different schedule moves the boundary", () => {
    const wednesdayOnly: readonly RearmBoundary[] = [{ hourUtc: 6, weekday: 3 }];
    expect(mostRecentSeedRearmBoundary(new Date("2026-09-18T12:00:00Z"), wednesdayOnly)).toEqual(
      new Date("2026-09-16T06:00:00Z"),
    );
    // Its own weekday before its hour still falls back a full week.
    expect(mostRecentSeedRearmBoundary(new Date("2026-09-16T05:00:00Z"), wednesdayOnly)).toEqual(
      new Date("2026-09-09T06:00:00Z"),
    );
  });
});

describe("the due rule the re-arm binds", () => {
  /** `rearmSeedLabels`' predicate, verbatim: `done_at < <the most recent boundary>`. */
  function isDue(doneAt: string, now: string): boolean {
    return doneAt < mostRecentSeedRearmBoundary(new Date(now)).toISOString();
  }

  it("is not due one second after a boundary when the node drained on it", () => {
    expect(isDue("2026-09-18T12:00:00.000Z", "2026-09-18T12:00:01.000Z")).toBe(false);
  });

  it("is due when the node drained one second before the boundary", () => {
    expect(isDue("2026-09-18T11:59:59.000Z", "2026-09-18T12:00:01.000Z")).toBe(true);
  });

  it("stays not-due for the whole pass, then comes due on the next boundary", () => {
    const drained = "2026-09-18T12:05:00.000Z";
    expect(isDue(drained, "2026-09-18T18:00:00.000Z")).toBe(false);
    expect(isDue(drained, "2026-09-19T23:59:00.000Z")).toBe(false);
    expect(isDue(drained, "2026-09-20T00:00:00.000Z")).toBe(true);
  });

  it("self-heals a missed pass — a node stranded for weeks is simply due", () => {
    expect(isDue("2026-08-01T00:00:00.000Z", "2026-09-17T09:00:00.000Z")).toBe(true);
  });
});
