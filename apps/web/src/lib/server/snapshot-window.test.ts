import { describe, expect, it } from "vitest";
import { clampSnapshotWindow } from "./snapshot-window";

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
    expect(clampSnapshotWindow(Number.POSITIVE_INFINITY)).toBe(90);
  });

  it("degrades a non-positive window to the default (never an empty series)", () => {
    expect(clampSnapshotWindow(0)).toBe(90);
    expect(clampSnapshotWindow(-1)).toBe(90);
    expect(clampSnapshotWindow(-365)).toBe(90);
  });

  it("degrades a non-number or NaN to the default", () => {
    expect(clampSnapshotWindow(Number.NaN)).toBe(90);
    expect(clampSnapshotWindow("30" as unknown as number)).toBe(90);
    expect(clampSnapshotWindow(null as unknown as number)).toBe(90);
  });

  it("truncates a fractional window toward zero rather than binding a float", () => {
    expect(clampSnapshotWindow(7.9)).toBe(7);
    expect(clampSnapshotWindow(0.5)).toBe(0);
  });
});
