import { describe, expect, it } from "vitest";

import {
  mostRecentSeedRearmBoundary,
  type RearmBoundary,
  SEED_REARM_SCHEDULE,
} from "./crawl-rearm-schedule";

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
  it("returns the boundary itself when now is exactly on one", () => {
    expect(boundaryOf("2026-09-18T12:00:00.000Z")).toBe("2026-09-18T12:00:00.000Z");
    expect(boundaryOf("2026-09-20T00:00:00.000Z")).toBe("2026-09-20T00:00:00.000Z");
    expect(boundaryOf("2026-09-22T00:00:00.000Z")).toBe("2026-09-22T00:00:00.000Z");
  });

  it("holds the previous boundary one millisecond before a new one opens", () => {
    expect(boundaryOf("2026-09-18T11:59:59.999Z")).toBe("2026-09-15T00:00:00.000Z");

    expect(boundaryOf("2026-09-19T23:59:59.999Z")).toBe("2026-09-18T12:00:00.000Z");

    expect(boundaryOf("2026-09-21T23:59:59.999Z")).toBe("2026-09-20T00:00:00.000Z");
  });

  it("moves to the new boundary one millisecond after it opens", () => {
    expect(boundaryOf("2026-09-18T12:00:00.001Z")).toBe("2026-09-18T12:00:00.000Z");
    expect(boundaryOf("2026-09-20T00:00:00.001Z")).toBe("2026-09-20T00:00:00.000Z");
    expect(boundaryOf("2026-09-22T00:00:00.001Z")).toBe("2026-09-22T00:00:00.000Z");
  });

  it("wraps across the week's longest gap (Tuesday → Friday)", () => {
    for (const iso of [
      "2026-09-15T00:00:00.000Z",
      "2026-09-15T23:00:00.000Z",
      "2026-09-16T08:30:00.000Z",
      "2026-09-17T19:45:00.000Z",
      "2026-09-18T00:00:00.000Z",
      "2026-09-18T11:00:00.000Z",
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
    expect(boundaryOf("2026-10-01T06:00:00.000Z")).toBe("2026-09-29T00:00:00.000Z");

    expect(boundaryOf("2027-01-01T09:00:00.000Z")).toBe("2026-12-29T00:00:00.000Z");
    expect(boundaryOf("2027-01-01T12:00:00.000Z")).toBe("2027-01-01T12:00:00.000Z");
  });

  it("is UTC only, so a DST shift in any local zone moves nothing", () => {
    expect(boundaryOf("2026-10-25T00:00:00.000Z")).toBe("2026-10-25T00:00:00.000Z");
    expect(boundaryOf("2026-10-25T01:30:00.000Z")).toBe("2026-10-25T00:00:00.000Z");

    expect(boundaryOf("2026-10-25T03:30:00.000+02:00")).toBe("2026-10-25T00:00:00.000Z");

    expect(boundaryOf("2026-03-29T02:00:00.000Z")).toBe("2026-03-29T00:00:00.000Z");
  });

  it("never returns a future instant, at any minute of a whole week", () => {
    const start = Date.parse("2026-09-14T00:00:00.000Z");
    for (let minute = 0; minute < 7 * 24 * 60; minute += 1) {
      const now = new Date(start + minute * 60_000);
      const boundary = mostRecentSeedRearmBoundary(now);
      expect(boundary.getTime()).toBeLessThanOrEqual(now.getTime());

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

    expect(mostRecentSeedRearmBoundary(new Date("2026-09-16T05:00:00Z"), wednesdayOnly)).toEqual(
      new Date("2026-09-09T06:00:00Z"),
    );
  });
});

describe("the due rule the re-arm binds", () => {
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
