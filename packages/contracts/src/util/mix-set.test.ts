import { describe, expect, it } from "bun:test";

import {
  isSetToken,
  MAX_SET_LENGTH,
  MAX_TASTE_ARTISTS,
  mixReasonLabel,
  parseSetParam,
  parseTasteParam,
  serializeSet,
  serializeTaste,
  setToken,
} from "./mix-set";

const SPOTIFY_ID = "4iV5W9uYEdYUVa79Axb7Rh";

describe("set links", () => {
  it("accepts finding coordinates and Spotify ids, but rejects malformed and mixtape ids", () => {
    const cases = [
      ["004.7.2I", true],
      [SPOTIFY_ID, true],
      ["3n3Pcfd0Zw8Yb9 mangled", false],
      ["019.F.1A", false],
    ] as const;

    for (const [token, expected] of cases) {
      expect(isSetToken(token)).toBe(expected);
    }
  });

  it("trims, validates, de-duplicates, and preserves the order of mixed tokens", () => {
    expect(parseSetParam(`004.7.2I, ${SPOTIFY_ID} ,011.1.6E,004.7.2I,019.F.1A,,nope`)).toEqual([
      "004.7.2I",
      SPOTIFY_ID,
      "011.1.6E",
    ]);
  });

  it("caps the chain at the published set limit", () => {
    const tokens = Array.from(
      { length: MAX_SET_LENGTH + 10 },
      (_, index) => `${String(index).padStart(3, "0")}.1.1A`,
    );

    expect(parseSetParam(tokens.join(","))).toEqual(tokens.slice(0, MAX_SET_LENGTH));
  });

  it("treats absent set parameters as an empty chain", () => {
    for (const input of ["", null, undefined]) {
      expect(parseSetParam(input)).toEqual([]);
    }
  });

  it("serializes the ordered chain for a URL", () => {
    expect(serializeSet(["004.7.2I", SPOTIFY_ID])).toBe(`004.7.2I,${SPOTIFY_ID}`);
  });

  it("uses a finding coordinate when available and the Spotify id otherwise", () => {
    expect(setToken({ logId: "004.7.2I", trackId: SPOTIFY_ID })).toBe("004.7.2I");
    expect(setToken({ trackId: SPOTIFY_ID })).toBe(SPOTIFY_ID);
  });
});

describe("taste seeds", () => {
  it("normalizes and de-duplicates valid artist slugs", () => {
    expect(parseTasteParam("Netsky, camo-krooked ,netsky,BAD SLUG!")).toEqual([
      "netsky",
      "camo-krooked",
    ]);
  });

  it("caps the seed at the published artist limit", () => {
    const slugs = Array.from({ length: MAX_TASTE_ARTISTS + 3 }, (_, index) => `artist-${index}`);

    expect(parseTasteParam(slugs.join(","))).toEqual(slugs.slice(0, MAX_TASTE_ARTISTS));
  });

  it("treats absent taste parameters as empty and serializes ordered slugs", () => {
    for (const input of ["", null, undefined]) {
      expect(parseTasteParam(input)).toEqual([]);
    }

    expect(serializeTaste(["netsky", "camo-krooked"])).toBe("netsky,camo-krooked");
  });
});

it("names mix relationships for the reason chip", () => {
  const cases = [
    [{ kind: "key", relationship: "same_key" }, "Same key"],
    [{ kind: "bpm", relationship: "tempo_match" }, "Tempo locked"],
    [{ kind: "sonic", relationship: "close_in_sound" }, "Close in sound"],
  ] as const;

  for (const [reason, expected] of cases) {
    expect(mixReasonLabel(reason)).toBe(expected);
  }
});
