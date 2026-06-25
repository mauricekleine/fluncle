// Focused test for the version-aware gate in analyze-track.ts. The Deezer-search +
// iTunes preview legs are gathered ALONGSIDE the ISRC candidate, and the run keeps
// the highest-confidence read — so without this gate a REMIX's BPM/key/feature
// vector could be computed from the ORIGINAL. Importing analyze-track.ts is safe:
// the pipeline is guarded by `if (import.meta.main)`, so the import only loads
// `versionMatches`.

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
