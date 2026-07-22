import { describe, expect, test } from "bun:test";

import {
  ANCHORED_P,
  BPM_MAX,
  BPM_MIN,
  buildTrackMetadata,
  byteLength,
  CAMELOT_KEYS,
  camelotKeyFor,
  centroidId,
  isIdSafe,
  MAX_ID_BYTES,
  trackId,
} from "../lib/metadata";
import { mulberry32 } from "../lib/prng";

describe("Camelot keys", () => {
  test("exactly 24 valid keys (12A..12B)", () => {
    expect(CAMELOT_KEYS.length).toBe(24);
    expect(new Set(CAMELOT_KEYS).size).toBe(24);
    for (const k of CAMELOT_KEYS) {
      expect(k).toMatch(/^(?:[1-9]|1[0-2])[AB]$/);
    }
  });
  test("camelotKeyFor only ever returns a valid key", () => {
    const r = mulberry32(4);
    const valid = new Set(CAMELOT_KEYS);
    for (let i = 0; i < 2000; i++) {
      expect(valid.has(camelotKeyFor(r))).toBe(true);
    }
  });
});

describe("buildTrackMetadata", () => {
  test("bpm within range and integer; booleans present", () => {
    const r = mulberry32(8);
    for (let i = 0; i < 2000; i++) {
      const m = buildTrackMetadata(r);
      expect(Number.isInteger(m.bpm)).toBe(true);
      expect(m.bpm).toBeGreaterThanOrEqual(BPM_MIN);
      expect(m.bpm).toBeLessThanOrEqual(BPM_MAX);
      expect(typeof m.anchored).toBe("boolean");
      expect(typeof m.certified).toBe("boolean");
    }
  });
  test("anchored rate approximates ANCHORED_P", () => {
    const r = mulberry32(2);
    let anchored = 0;
    const N = 20_000;
    for (let i = 0; i < N; i++) {
      if (buildTrackMetadata(r).anchored) {
        anchored++;
      }
    }
    expect(Math.abs(anchored / N - ANCHORED_P)).toBeLessThan(0.02);
  });
});

describe("id safety (≤64 bytes)", () => {
  test("MAX_ID_BYTES is 64", () => {
    expect(MAX_ID_BYTES).toBe(64);
  });
  test("byteLength counts UTF-8 bytes not chars", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("é")).toBe(2);
    expect(byteLength("🎧")).toBe(4);
  });
  test("generated ids stay id-safe at the top of the range", () => {
    for (const i of [0, 1, 149_999, 999_999_999]) {
      expect(isIdSafe(trackId(i))).toBe(true);
      expect(isIdSafe(centroidId(i))).toBe(true);
    }
  });
  test("isIdSafe rejects empty and over-long", () => {
    expect(isIdSafe("")).toBe(false);
    expect(isIdSafe("x".repeat(65))).toBe(false);
    expect(isIdSafe("x".repeat(64))).toBe(true);
  });
});
