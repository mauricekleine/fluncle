import { describe, expect, it } from "vitest";
import {
  canonicalIdentityKey,
  normalizeDeezerKey,
  normalizeIsrcKey,
  normalizeMbidKey,
  normalizeSpotifyKey,
  platformIdentityKey,
} from "./identity-key";

const SPOTIFY_ID = "4cOdK2wGLETKBW3PvgPWqT";

describe("normalizeSpotifyKey", () => {
  it("reads every spelling a caller can arrive with", () => {
    const accepted = [
      `https://open.spotify.com/track/${SPOTIFY_ID}`,

      `https://open.spotify.com/track/${SPOTIFY_ID}?si=8f0e1c2d3b4a5968`,

      `https://open.spotify.com/intl-nl/track/${SPOTIFY_ID}`,
      `https://open.spotify.com/intl-de/track/${SPOTIFY_ID}?si=x&nd=1`,

      `open.spotify.com/track/${SPOTIFY_ID}`,

      `spotify:track:${SPOTIFY_ID}`,

      SPOTIFY_ID,

      `  ${SPOTIFY_ID}  `,

      `https://open.spotify.com/track/${SPOTIFY_ID}#play`,
    ];

    for (const raw of accepted) {
      expect(normalizeSpotifyKey(raw), raw).toBe(SPOTIFY_ID);
    }
  });

  it("refuses what is not a Spotify track key", () => {
    const refused = [
      "",
      "nope",

      `https://example.com/track/${SPOTIFY_ID}`,

      "https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3",

      "https://open.spotify.com/track/4cOdK2wGLETKBW3Pvg",

      "https://www.deezer.com/track/3135556",
    ];

    for (const raw of refused) {
      expect(normalizeSpotifyKey(raw), raw).toBeUndefined();
    }
  });
});

describe("normalizeDeezerKey", () => {
  it("reads every spelling a caller can arrive with", () => {
    const accepted = [
      "https://www.deezer.com/track/3135556",
      "https://deezer.com/track/3135556",

      "https://www.deezer.com/nl/track/3135556",
      "https://www.deezer.com/en/track/3135556?utm_source=deezer&utm_campaign=share",
      "deezer.com/track/3135556",
      "3135556",
    ];

    for (const raw of accepted) {
      expect(normalizeDeezerKey(raw), raw).toBe("3135556");
    }
  });

  it("refuses what is not a Deezer track key", () => {
    for (const raw of [
      "",
      "nope",
      "https://example.com/track/3135556",
      "https://www.deezer.com/album/302127",

      `https://www.deezer.com/track/${SPOTIFY_ID}`,
    ]) {
      expect(normalizeDeezerKey(raw), raw).toBeUndefined();
    }
  });
});

describe("platformIdentityKey", () => {
  it("reads only the forms that NAME their platform", () => {
    expect(platformIdentityKey(`https://open.spotify.com/track/${SPOTIFY_ID}`)).toEqual({
      id: SPOTIFY_ID,
      platform: "spotify",
    });
    expect(platformIdentityKey(`spotify:track:${SPOTIFY_ID}`)).toEqual({
      id: SPOTIFY_ID,
      platform: "spotify",
    });
    expect(platformIdentityKey("https://www.deezer.com/nl/track/3135556")).toEqual({
      id: "3135556",
      platform: "deezer",
    });
    expect(platformIdentityKey("deezer:track:3135556")).toEqual({
      id: "3135556",
      platform: "deezer",
    });
  });

  it("REFUSES a bare id, because the page has no second field to disambiguate it", () => {
    expect(platformIdentityKey(SPOTIFY_ID)).toBeUndefined();
    expect(platformIdentityKey("3135556")).toBeUndefined();
    expect(platformIdentityKey("004.7.2I")).toBeUndefined();
  });
});

describe("canonicalIdentityKey", () => {
  it("collapses every spelling of one link onto one address", () => {
    const spellings = [
      `https://open.spotify.com/track/${SPOTIFY_ID}?si=abc`,
      `https://open.spotify.com/intl-nl/track/${SPOTIFY_ID}`,
      `spotify:track:${SPOTIFY_ID}`,
    ];

    for (const raw of spellings) {
      expect(canonicalIdentityKey(raw), raw).toBe(`spotify:track:${SPOTIFY_ID}`);
    }

    expect(canonicalIdentityKey("https://www.deezer.com/nl/track/3135556?utm_source=share")).toBe(
      "deezer:track:3135556",
    );
  });

  it("leaves the identifier keys exactly where they were", () => {
    expect(canonicalIdentityKey("gb-abc-12-34567")).toBe("GBABC1234567");
    expect(canonicalIdentityKey("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")).toBe(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
    expect(canonicalIdentityKey(" 004.7.2I ")).toBe("004.7.2I");

    expect(canonicalIdentityKey(SPOTIFY_ID)).toBe(SPOTIFY_ID);
  });
});

describe("the identifier keys", () => {
  it("still normalize as they always did", () => {
    expect(normalizeIsrcKey("GB ABC 12 34567")).toBe("GBABC1234567");
    expect(normalizeIsrcKey("nope")).toBeUndefined();
    expect(normalizeMbidKey("mb_AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")).toBe(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
    expect(normalizeMbidKey("nope")).toBeUndefined();
  });
});
