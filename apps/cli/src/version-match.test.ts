// The preview-archive backfill writes to R2 and is then served as confidence-1
// "exact" to every future render — the worst blast radius for a wrong recording.
// Its fuzzy Deezer/iTunes fallbacks are now gated by these helpers: a REMIX finding
// must never archive the ORIGINAL's preview (and vice-versa).

import { describe, expect, test } from "bun:test";

import {
  baseTitleMatches,
  isRemix,
  stripVersionSuffix,
  versionMatches,
} from "@fluncle/contracts/util";

const REMIX = "In And Out Of Phase - Calyx & TeeBee Remix";

describe("isRemix / stripVersionSuffix", () => {
  test("a third-party remix is a remix; the original is not", () => {
    expect(isRemix(REMIX)).toBe(true);
    expect(isRemix("In And Out Of Phase")).toBe(false);
    expect(isRemix("In And Out Of Phase - Original Mix")).toBe(false);
  });

  test("the version suffix strips to the bare base title", () => {
    expect(stripVersionSuffix(REMIX)).toBe("In And Out Of Phase");
    expect(stripVersionSuffix("In And Out Of Phase - Original Mix")).toBe("In And Out Of Phase");
  });
});

describe("versionMatches — the wrong-recording gate", () => {
  test("a remix finding rejects the original and a different remix", () => {
    expect(versionMatches(REMIX, "In And Out Of Phase")).toBe(false);
    expect(versionMatches(REMIX, "In And Out Of Phase - Noisia Remix")).toBe(false);
  });

  test("a remix finding accepts its own remix (dash + bracket)", () => {
    expect(versionMatches(REMIX, "In And Out Of Phase - Calyx & TeeBee Remix")).toBe(true);
    expect(versionMatches(REMIX, "In And Out Of Phase (Calyx & TeeBee Remix)")).toBe(true);
  });

  test("an original finding rejects a third-party remix", () => {
    expect(versionMatches("In And Out Of Phase", REMIX)).toBe(false);
  });

  test("an original finding accepts the original / artist edits", () => {
    expect(versionMatches("In And Out Of Phase - Original Mix", "In And Out Of Phase")).toBe(true);
    expect(versionMatches("The Nine", "The Nine - Radio Edit")).toBe(true);
  });
});

describe("baseTitleMatches", () => {
  test("every base-title token must appear in the candidate", () => {
    expect(baseTitleMatches(REMIX, "In And Out Of Phase (Calyx & TeeBee Remix)")).toBe(true);
    expect(baseTitleMatches("In And Out Of Phase", "Out Of Phase")).toBe(false);
    expect(baseTitleMatches("In And Out Of Phase", "Some Other Track")).toBe(false);
  });

  test("an empty finding title never matches", () => {
    expect(baseTitleMatches("", "Anything")).toBe(false);
  });
});
