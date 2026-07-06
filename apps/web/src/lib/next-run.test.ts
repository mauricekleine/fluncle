import { describe, expect, it } from "vitest";
import { estimateNextRun, formatCadence, formatCountdown } from "./next-run";

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
