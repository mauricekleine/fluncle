import { describe, expect, test } from "bun:test";
import { nextOffset } from "./mixtape-youtube";

// The resume-offset math for the YouTube resumable PUT: a 308 carries a confirmed
// `Range: bytes=0-<lastByte>`, and the next byte to send is lastByte + 1.
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
