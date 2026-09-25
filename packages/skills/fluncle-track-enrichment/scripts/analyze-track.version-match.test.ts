import { describe, expect, test } from "bun:test";

import { versionMatches } from "./analyze-track.ts";

const REMIX = "In And Out Of Phase - Calyx & TeeBee Remix";

describe("versionMatches (enrichment preview gate)", () => {
  test("a remix finding rejects the original (won't analyze the wrong recording)", () => {
    expect(versionMatches(REMIX, "In And Out Of Phase")).toBe(false);
    expect(versionMatches(REMIX, "In And Out Of Phase - Original Mix")).toBe(false);
  });

  test("a remix finding rejects a different remix", () => {
    expect(versionMatches(REMIX, "In And Out Of Phase - Noisia Remix")).toBe(false);
  });

  test("a remix finding accepts its own remix (dash + bracket)", () => {
    expect(versionMatches(REMIX, "In And Out Of Phase - Calyx & TeeBee Remix")).toBe(true);
    expect(versionMatches(REMIX, "In And Out Of Phase (Calyx & TeeBee Remix)")).toBe(true);
  });

  test("an original finding rejects a third-party remix but accepts the original", () => {
    expect(versionMatches("In And Out Of Phase", REMIX)).toBe(false);
    expect(versionMatches("In And Out Of Phase", "In And Out Of Phase")).toBe(true);
    expect(versionMatches("The Nine", "The Nine - Radio Edit")).toBe(true);
  });
});
