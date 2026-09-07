import { describe, expect, it } from "vitest";
import { parseBool, parseLimit } from "./query-params";

// The shared query-param coercion (query-params.ts) is re-exported by `orpc/_shared.ts` and
// applied by ~40 handlers across the public and admin surfaces, each passing its OWN
// default/max. The contracts deliberately keep `limit` a raw string so `?limit=abc` degrades
// instead of 400-ing, which means EVERY malformed value that reaches a handler is silenced
// here — and a silent coercion is exactly the kind of thing that flips under a refactor with
// nothing to catch it (`Number.parseInt` → `Number()`, `< 1` → `< 0`, `!value` → `value ==
// null`). These pin the degradation contract itself: a bad limit becomes the caller's
// fallback, a large one is capped, and neither is ever allowed through as 0, negative, or NaN
// into a `limit ?` bind.

describe("parseLimit — the tolerant limit clamp", () => {
  it("returns the caller's fallback for a missing value", () => {
    expect(parseLimit(undefined, 24, 60)).toBe(24);
    // URLSearchParams.get() returns null for an absent param; the oRPC query bag returns
    // undefined. Both spellings reach this function, so both must degrade the same way.
    expect(parseLimit(null, 24, 60)).toBe(24);
    // "" is falsy, so it short-circuits before parseInt ever sees it.
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
    // Past Number.MAX_SAFE_INTEGER parseInt yields a finite float; it must still cap and
    // never reach a SQL bind as an unbounded page size.
    expect(parseLimit("999999999999999999999", 50, 200)).toBe(200);
  });

  it("degrades a non-positive limit to the fallback (never 0, never negative)", () => {
    // A `limit 0` bind returns an empty page and reads to the caller as "there is nothing
    // here" — the failure mode this clamp exists to prevent.
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
    // Documented rather than defended: `parseInt` stops at the first non-digit, so "12abc"
    // is 12 and "1e3" is 1 (not 1000). Both are still clamped into range, so the worst case
    // is a smaller page than the caller asked for — never an unbounded or empty one.
    expect(parseLimit("12abc", 24, 60)).toBe(12);
    expect(parseLimit("1e3", 24, 200)).toBe(1);
    expect(parseLimit("  8  ", 24, 60)).toBe(8);
    // A fractional string truncates toward its integer part rather than degrading.
    expect(parseLimit("7.9", 24, 60)).toBe(7);
  });
});

describe("parseBool — the tolerant boolean flag", () => {
  it("is true for exactly `1` and `true`", () => {
    expect(parseBool("1")).toBe(true);
    expect(parseBool("true")).toBe(true);
  });

  it("is false for everything else, including near-misses", () => {
    // Deliberately strict and case-SENSITIVE: an opt-in flag that guesses is worse than one
    // that stays off, so "TRUE"/"yes"/"on" are all false until someone widens this on purpose.
    for (const value of ["TRUE", "True", "yes", "on", "0", "false", "", "2", " 1"]) {
      expect(parseBool(value), `parseBool(${JSON.stringify(value)})`).toBe(false);
    }
  });

  it("is false for a missing value", () => {
    expect(parseBool(null)).toBe(false);
    expect(parseBool(undefined)).toBe(false);
  });
});
