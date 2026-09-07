import { describe, expect, it } from "vitest";
import { clampSnapshotWindow } from "./snapshot-window";

// The bounded day-window the three daily-snapshot series readers share — the catalogue funnel
// (funnel.ts:780), the platform-stats page (platform-stats.ts:740), and the reach board
// (reach-board.ts:393). All three feed the result straight into a `>= date(...,'-N days')`
// series read, so this clamp is the ONLY thing standing between a caller-supplied number and
// the size of that scan. It also has no other guard in front of it: the value arrives as an
// optional number, so `undefined`, a fractional page-size, a negative, and NaN all land here.

describe("clampSnapshotWindow", () => {
  it("defaults to a 90-day season when no window is asked for", () => {
    expect(clampSnapshotWindow()).toBe(90);
    expect(clampSnapshotWindow(undefined)).toBe(90);
  });

  it("passes an in-range window through untouched", () => {
    expect(clampSnapshotWindow(1)).toBe(1);
    expect(clampSnapshotWindow(30)).toBe(30);
    expect(clampSnapshotWindow(90)).toBe(90);
    expect(clampSnapshotWindow(365)).toBe(365);
  });

  it("caps at 365 days — the bound that keeps the series read small", () => {
    expect(clampSnapshotWindow(366)).toBe(365);
    expect(clampSnapshotWindow(10_000)).toBe(365);
    expect(clampSnapshotWindow(Number.MAX_SAFE_INTEGER)).toBe(365);
    // Infinity is finite-checked, so it degrades to the default rather than capping.
    expect(clampSnapshotWindow(Number.POSITIVE_INFINITY)).toBe(90);
  });

  it("degrades a non-positive window to the default (never an empty series)", () => {
    // A `0` window would render an empty chart that reads as "nothing happened" rather than
    // "you asked for no days".
    expect(clampSnapshotWindow(0)).toBe(90);
    expect(clampSnapshotWindow(-1)).toBe(90);
    expect(clampSnapshotWindow(-365)).toBe(90);
  });

  it("degrades a non-number or NaN to the default", () => {
    expect(clampSnapshotWindow(Number.NaN)).toBe(90);
    // The signature is `windowDays?: number`, but the callers read it off a request payload,
    // so a string surviving validation must not become `'30' days` in the SQL.
    expect(clampSnapshotWindow("30" as unknown as number)).toBe(90);
    expect(clampSnapshotWindow(null as unknown as number)).toBe(90);
  });

  it("truncates a fractional window toward zero rather than binding a float", () => {
    expect(clampSnapshotWindow(7.9)).toBe(7);
    // The one sharp edge, pinned rather than endorsed: the `<= 0` guard runs BEFORE the
    // truncation, so a fraction under 1 survives the guard and truncates to a zero-day
    // window. Unreachable today — all three callers pre-parse with `Number.parseInt`
    // (orpc/reach.ts:17, orpc/admin-funnel.ts:35, orpc/admin-social.ts:624), so only an
    // integer or `undefined` ever arrives. This is the tripwire if a caller stops doing that.
    expect(clampSnapshotWindow(0.5)).toBe(0);
  });
});
