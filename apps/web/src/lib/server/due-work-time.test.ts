import { describe, expect, it } from "vitest";

import { dueWorkNowIso } from "./due-work-time";

describe("dueWorkNowIso", () => {
  it("normalizes a Date or an ISO string to the same UTC instant", () => {
    const instant = "2026-01-02T03:04:05.000Z";

    expect(dueWorkNowIso(new Date(instant))).toBe(instant);
    expect(dueWorkNowIso(instant)).toBe(instant);
    expect(dueWorkNowIso("2026-01-02T08:34:05+05:30")).toBe(instant);
  });

  it("refuses an unparseable now instead of evaluating due work against it", () => {
    expect(() => dueWorkNowIso("not a timestamp")).toThrow(
      "Due-work evaluation requires a valid now timestamp",
    );
    expect(() => dueWorkNowIso(new Date(Number.NaN))).toThrow(RangeError);
  });
});
