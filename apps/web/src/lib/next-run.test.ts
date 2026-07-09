import { describe, expect, it } from "vitest";
import {
  estimateNextRun,
  formatCadence,
  formatCountdown,
  formatZonedTime,
  nextScheduledRun,
} from "./next-run";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// A fixed reference instant so every case is deterministic (no wall clock).
const NOW = "2026-07-06T12:00:00.000Z";
const nowMs = new Date(NOW).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

describe("estimateNextRun", () => {
  it("returns lastSeen + cadence when that instant is still in the future", () => {
    // Probed 1m ago, 5m cadence → next tick is 4m out (lastSeen + 5m).
    const lastSeen = iso(nowMs - MINUTE);
    expect(estimateNextRun(lastSeen, 5 * MINUTE, NOW)).toBe(iso(nowMs + 4 * MINUTE));
  });

  it("rolls a stale estimate forward to the NEXT future tick (a coarse probe on a fast cron)", () => {
    // The 10m healthcheck probe is older than one 5m cadence: lastSeen + 5m is already
    // past, so the estimate must step forward to the first future tick, not read stuck.
    const lastSeen = iso(nowMs - 8 * MINUTE);
    // lastSeen + 5m = 3m ago; +5m = 2m out.
    expect(estimateNextRun(lastSeen, 5 * MINUTE, NOW)).toBe(iso(nowMs + 2 * MINUTE));
  });

  it("steps strictly PAST now when lastSeen + k·cadence lands exactly on now", () => {
    // lastSeen exactly one cadence before now → lastSeen + cadence == now; the result
    // must be the following tick (strictly future), never now itself.
    const lastSeen = iso(nowMs - 5 * MINUTE);
    expect(estimateNextRun(lastSeen, 5 * MINUTE, NOW)).toBe(iso(nowMs + 5 * MINUTE));
  });

  it("resolves a months-stale timestamp on a weekly cadence in one hop", () => {
    // A long-dark cron: lastSeen ~30 days ago, weekly cadence. The next tick is still a
    // clean future instant (proves the O(1) roll-forward, no unbounded loop).
    const lastSeen = iso(nowMs - 30 * DAY);
    const next = estimateNextRun(lastSeen, 7 * DAY, NOW);
    expect(next).not.toBeNull();
    const nextMs = new Date(next ?? "").getTime();
    expect(nextMs).toBeGreaterThan(nowMs);
    // It sits within one cadence above now, aligned to the lastSeen + k·7d grid.
    expect(nextMs - nowMs).toBeLessThanOrEqual(7 * DAY);
    expect((nextMs - new Date(lastSeen).getTime()) % (7 * DAY)).toBe(0);
  });

  it("returns null for an unparseable last-seen timestamp (a never-run / missing stamp)", () => {
    expect(estimateNextRun("not-a-date", 5 * MINUTE, NOW)).toBeNull();
    expect(estimateNextRun("", 5 * MINUTE, NOW)).toBeNull();
  });

  it("returns null for a non-positive or non-finite cadence", () => {
    const lastSeen = iso(nowMs - MINUTE);
    expect(estimateNextRun(lastSeen, 0, NOW)).toBeNull();
    expect(estimateNextRun(lastSeen, -5 * MINUTE, NOW)).toBeNull();
    expect(estimateNextRun(lastSeen, Number.NaN, NOW)).toBeNull();
    expect(estimateNextRun(lastSeen, Number.POSITIVE_INFINITY, NOW)).toBeNull();
  });

  it("returns null for an unparseable now", () => {
    expect(estimateNextRun(iso(nowMs), 5 * MINUTE, "nope")).toBeNull();
  });
});

describe("formatCountdown", () => {
  it("renders whole minutes under an hour", () => {
    expect(formatCountdown(iso(nowMs + 4 * MINUTE), NOW)).toBe("in 4m");
    expect(formatCountdown(iso(nowMs + 59 * MINUTE), NOW)).toBe("in 59m");
  });

  it("renders whole hours under a day", () => {
    expect(formatCountdown(iso(nowMs + 3 * HOUR), NOW)).toBe("in 3h");
    expect(formatCountdown(iso(nowMs + 23 * HOUR + 30 * MINUTE), NOW)).toBe("in 23h");
  });

  it("renders whole days beyond a day", () => {
    expect(formatCountdown(iso(nowMs + 7 * DAY), NOW)).toBe("in 7d");
  });

  it("reads 'imminent' under a minute out, at now, or already past", () => {
    expect(formatCountdown(iso(nowMs + 30_000), NOW)).toBe("imminent");
    expect(formatCountdown(NOW, NOW)).toBe("imminent");
    expect(formatCountdown(iso(nowMs - 5 * MINUTE), NOW)).toBe("imminent");
    expect(formatCountdown("not-a-date", NOW)).toBe("imminent");
  });
});

describe("formatCadence", () => {
  it("uses the largest clean whole unit", () => {
    expect(formatCadence(5 * MINUTE)).toBe("5m");
    expect(formatCadence(30 * MINUTE)).toBe("30m");
    expect(formatCadence(60 * MINUTE)).toBe("1h");
    expect(formatCadence(24 * HOUR)).toBe("1d");
    expect(formatCadence(7 * DAY)).toBe("7d");
  });

  it("floors a non-whole cadence to minutes and guards a bad input", () => {
    expect(formatCadence(90_000)).toBe("1m");
    expect(formatCadence(0)).toBe("");
    expect(formatCadence(-1)).toBe("");
    expect(formatCadence(Number.NaN)).toBe("");
  });
});

describe("nextScheduledRun", () => {
  const AUDIT = { time: "01:00", tz: "Europe/Amsterdam" };
  const NEWSLETTER = { time: "15:00", tz: "Europe/Amsterdam", weekday: 5 };

  it("daily 01:00 Amsterdam in SUMMER resolves to 23:00 UTC (CEST = UTC+2)", () => {
    // Thu 2026-07-09 12:00 CEST — today's 01:00 already passed, so tomorrow's fire.
    expect(nextScheduledRun(AUDIT, "2026-07-09T10:00:00.000Z")).toBe("2026-07-09T23:00:00.000Z");
  });

  it("returns today's fire when it is still ahead", () => {
    // 2026-07-09 00:30 CEST — 01:00 CEST today is 30m out.
    expect(nextScheduledRun(AUDIT, "2026-07-08T22:30:00.000Z")).toBe("2026-07-08T23:00:00.000Z");
  });

  it("daily 01:00 Amsterdam in WINTER resolves to 00:00 UTC (CET = UTC+1)", () => {
    // The DST-correct half: a fixed LOCAL time maps to a DIFFERENT UTC instant off-season.
    expect(nextScheduledRun(AUDIT, "2026-01-15T10:00:00.000Z")).toBe("2026-01-16T00:00:00.000Z");
  });

  it("weekly Friday 15:00 Amsterdam fires the NEXT Friday (13:00 UTC in summer)", () => {
    // Thu 2026-07-09 → the newsletter fires TOMORROW (Fri Jul 10), not +7d from a probe.
    expect(nextScheduledRun(NEWSLETTER, "2026-07-09T10:00:00.000Z")).toBe(
      "2026-07-10T13:00:00.000Z",
    );
  });

  it("returns the weekday's fire when it is still ahead", () => {
    // Fri 2026-07-10 12:00 CEST — today's 15:00 CEST is 3h out.
    expect(nextScheduledRun(NEWSLETTER, "2026-07-10T10:00:00.000Z")).toBe(
      "2026-07-10T13:00:00.000Z",
    );
  });

  it("rolls to next week once the weekday's time has passed", () => {
    // Fri 2026-07-10 16:00 CEST — this Friday's 15:00 is gone → Fri Jul 17.
    expect(nextScheduledRun(NEWSLETTER, "2026-07-10T14:00:00.000Z")).toBe(
      "2026-07-17T13:00:00.000Z",
    );
  });

  it("returns null on an unusable time or now", () => {
    expect(nextScheduledRun({ time: "oops", tz: "Europe/Amsterdam" }, NOW)).toBeNull();
    expect(nextScheduledRun(AUDIT, "not-a-date")).toBeNull();
  });
});

describe("formatZonedTime", () => {
  it("renders the instant in its own zone with a city label", () => {
    // 23:00 UTC = 01:00 the NEXT day in Amsterdam (CEST) — the local face of the audit fire.
    expect(formatZonedTime("2026-07-09T23:00:00.000Z", "Europe/Amsterdam")).toBe(
      "Jul 10, 01:00 Amsterdam",
    );
    // 13:00 UTC = 15:00 CEST — the newsletter fire.
    expect(formatZonedTime("2026-07-10T13:00:00.000Z", "Europe/Amsterdam")).toBe(
      "Jul 10, 15:00 Amsterdam",
    );
  });

  it("returns empty on a bad instant", () => {
    expect(formatZonedTime("not-a-date", "Europe/Amsterdam")).toBe("");
  });
});
