// The identity KEY grammar, unit-tested — the pure string half of the identity surface.
//
// It earns its own suite because it is the only part of the surface a caller touches BEFORE
// anything is looked up, and because the shapes it has to accept are dictated by other people's
// products: what a Spotify share sheet puts on the clipboard, what a Deezer link looks like in a
// Dutch browser, what a playlist exporter writes into a CSV. Every case below is one of those, and
// none of them can be discovered from this repo.

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
      // The share sheet's tracking tail.
      `https://open.spotify.com/track/${SPOTIFY_ID}?si=8f0e1c2d3b4a5968`,
      // A locale segment, which the web player adds for a signed-in reader.
      `https://open.spotify.com/intl-nl/track/${SPOTIFY_ID}`,
      `https://open.spotify.com/intl-de/track/${SPOTIFY_ID}?si=x&nd=1`,
      // No scheme, as a link pasted out of a chat window often arrives.
      `open.spotify.com/track/${SPOTIFY_ID}`,
      // The desktop client's URI.
      `spotify:track:${SPOTIFY_ID}`,
      // The bare id.
      SPOTIFY_ID,
      // Whitespace from a sloppy paste.
      `  ${SPOTIFY_ID}  `,
      // A fragment, which some clients append.
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
      // The HOST is checked, so somebody else's `/track/` path is not a Spotify key.
      `https://example.com/track/${SPOTIFY_ID}`,
      // An album, not a track. `track` never appears, so there is nothing to read.
      "https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3",
      // The right shape, the wrong length — a truncated id is a typo, and saying so beats
      // answering "nothing on file" about a key that was never valid.
      "https://open.spotify.com/track/4cOdK2wGLETKBW3Pvg",
      // A Deezer link is not a Spotify key, however it is spelled.
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
      // The locale segment Deezer puts in front of the path.
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
      // A Deezer id is decimal; a base62 string is a Spotify id wearing the wrong key.
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
    // A bare Spotify id and Fluncle's own track id for a published finding are the same string, so
    // the page reads only the platform-named forms and a bare string stays a reference key. The API
    // is the other side of this: there the query key names the platform, so a bare id is fine.
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
    // A bare Spotify-shaped string is a track id here, not a platform key — unchanged behaviour.
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
