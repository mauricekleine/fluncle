import { describe, expect, test } from "bun:test";
import { nextOffset } from "./mixtape-youtube";

describe("nextOffset", () => {
  test("parses a confirmed range to the next byte offset", () => {
    expect(nextOffset("bytes=0-262143", 0)).toBe(262144);
  });

  test("handles a zero-length confirmed range", () => {
    expect(nextOffset("bytes=0-0", 99)).toBe(1);
  });

  test("falls back when the header is missing", () => {
    expect(nextOffset(null, 512)).toBe(512);
  });

  test("falls back when the header is unparseable", () => {
    expect(nextOffset("garbage", 512)).toBe(512);
  });
});
