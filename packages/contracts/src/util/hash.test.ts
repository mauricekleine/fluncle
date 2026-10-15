import { describe, expect, it } from "bun:test";

import { fnv1a32, fnv1a64 } from "./hash";

describe("fnv1a32", () => {
  it("matches the FNV-1a 32-bit reference vectors", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });

  it("starts from a caller's seed instead of the offset basis", () => {
    expect(fnv1a32("", 0x01000193)).toBe(0x01000193);
    expect(fnv1a32("a", 0x01000193)).toBe(0x85030ff6);
    expect(fnv1a32("a", 0x01000193)).not.toBe(fnv1a32("a"));
  });

  it("hashes UTF-16 code units, so an astral character folds in as its surrogate pair", () => {
    expect(fnv1a32("é")).toBe(0x6c0b6c44);
    expect(fnv1a32("😀")).toBe(0xcb31c4b8);
  });

  it("always returns an unsigned 32-bit integer", () => {
    for (const value of ["", "a", "foobar", "049.0.1N", "é", "😀", "x".repeat(1024)]) {
      const hash = fnv1a32(value);

      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("fnv1a64", () => {
  it("matches the FNV-1a 64-bit reference vectors", () => {
    expect(fnv1a64("")).toBe(0xcbf29ce484222325n);
    expect(fnv1a64("a")).toBe(0xaf63dc4c8601ec8cn);
    expect(fnv1a64("foobar")).toBe(0x85944171f73967e8n);
  });

  it("hashes UTF-8 bytes, so a non-ASCII character folds in byte by byte", () => {
    expect(fnv1a64("é")).toBe(0x0ac21707b7181e01n);
  });

  it("always returns an unsigned 64-bit bigint", () => {
    for (const value of ["", "a", "foobar", "é", "😀", "x".repeat(1024)]) {
      const hash = fnv1a64(value);

      expect(hash).toBeGreaterThanOrEqual(0n);
      expect(hash).toBeLessThan(1n << 64n);
    }
  });
});
