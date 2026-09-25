import { describe, expect, it } from "vitest";
import { parseBool, parseLimit } from "./query-params";

describe("parseLimit — the tolerant limit clamp", () => {
  it("returns the caller's fallback for a missing value", () => {
    expect(parseLimit(undefined, 24, 60)).toBe(24);
    expect(parseLimit(null, 24, 60)).toBe(24);
    expect(parseLimit("", 24, 60)).toBe(24);
  });

  it("passes an in-range integer through untouched", () => {
    expect(parseLimit("1", 24, 60)).toBe(1);
    expect(parseLimit("37", 24, 60)).toBe(37);
    expect(parseLimit("60", 24, 60)).toBe(60);
  });

  it("caps at the caller's max rather than faulting", () => {
    expect(parseLimit("61", 24, 60)).toBe(60);
    expect(parseLimit("100000", 50, 200)).toBe(200);
    expect(parseLimit("999999999999999999999", 50, 200)).toBe(200);
  });

  it("degrades a non-positive limit to the fallback (never 0, never negative)", () => {
    expect(parseLimit("0", 24, 60)).toBe(24);
    expect(parseLimit("-1", 24, 60)).toBe(24);
    expect(parseLimit("-9999", 24, 60)).toBe(24);
  });

  it("degrades unparseable input to the fallback instead of binding NaN", () => {
    expect(parseLimit("abc", 24, 60)).toBe(24);
    expect(parseLimit("NaN", 24, 60)).toBe(24);
    expect(parseLimit(" ", 24, 60)).toBe(24);
    expect(parseLimit("Infinity", 24, 60)).toBe(24);
  });

  it("takes the leading integer of a mixed string — parseInt's tolerance, stated on purpose", () => {
    expect(parseLimit("12abc", 24, 60)).toBe(12);
    expect(parseLimit("1e3", 24, 200)).toBe(1);
    expect(parseLimit("  8  ", 24, 60)).toBe(8);
    expect(parseLimit("7.9", 24, 60)).toBe(7);
  });
});

describe("parseBool — the tolerant boolean flag", () => {
  it("is true for exactly `1` and `true`", () => {
    expect(parseBool("1")).toBe(true);
    expect(parseBool("true")).toBe(true);
  });

  it("is false for everything else, including near-misses", () => {
    for (const value of ["TRUE", "True", "yes", "on", "0", "false", "", "2", " 1"]) {
      expect(parseBool(value), `parseBool(${JSON.stringify(value)})`).toBe(false);
    }
  });

  it("is false for a missing value", () => {
    expect(parseBool(null)).toBe(false);
    expect(parseBool(undefined)).toBe(false);
  });
});
