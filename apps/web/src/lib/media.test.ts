import { describe, expect, it } from "vitest";
import {
  FOUND_BASE,
  spotifyAlbumImageAtSize,
  trackMedia,
  videoPoster,
  videoRendition,
} from "./media";

// The Media Transformations URLs are same-zone: the /cdn-cgi/media prefix lives
// on the found.fluncle.com zone and the source is the master on that same zone,
// so the transform never crosses an origin. These tests pin the URL shape
// (https://developers.cloudflare.com/stream/transform-videos/) so a typo in the
// options string — which would silently 404 to the fallback — is caught here.
describe("videoRendition", () => {
  it("builds a same-zone mode=video transform pointing at the master footage", () => {
    expect(videoRendition("ABC123", { width: 720 })).toBe(
      `${FOUND_BASE}/cdn-cgi/media/mode=video,width=720/${FOUND_BASE}/ABC123/footage.mp4`,
    );
  });

  it("carries the requested rung into the width option", () => {
    expect(videoRendition("ABC123", { width: 360 })).toContain("mode=video,width=360/");
    expect(videoRendition("ABC123", { width: 1080 })).toContain("mode=video,width=1080/");
  });

  it("encodes the Log ID in the source URL", () => {
    expect(videoRendition("a/b c", { width: 480 })).toBe(
      `${FOUND_BASE}/cdn-cgi/media/mode=video,width=480/${FOUND_BASE}/a%2Fb%20c/footage.mp4`,
    );
  });

  it("targets the same master that trackMedia() returns", () => {
    const logId = "ABC123";
    expect(videoRendition(logId, { width: 720 })).toContain(trackMedia(logId).videoUrl);
  });
});

describe("videoPoster", () => {
  it("builds a same-zone mode=frame transform for a cheap opening still", () => {
    expect(videoPoster("ABC123")).toBe(
      `${FOUND_BASE}/cdn-cgi/media/mode=frame,time=0s,format=jpg/${FOUND_BASE}/ABC123/footage.mp4`,
    );
  });

  it("encodes the Log ID in the source URL", () => {
    expect(videoPoster("a/b c")).toBe(
      `${FOUND_BASE}/cdn-cgi/media/mode=frame,time=0s,format=jpg/${FOUND_BASE}/a%2Fb%20c/footage.mp4`,
    );
  });
});

// Spotify encodes the pixel size in the image-id PREFIX (ab67616d0000b273 = 640²,
// ab67616d00001e02 = 300², ab67616d00004851 = 64²). The helper swaps that prefix
// to right-size a stored cover; these tests pin the codes (verified to resolve on
// i.scdn.co) and guard the pass-through so a non-Spotify URL is never mangled.
describe("spotifyAlbumImageAtSize", () => {
  const HASH = "18c0fd64aad5d4fb51a499b0";
  const stored = `https://i.scdn.co/image/ab67616d00001e02${HASH}`; // the 300² we store

  it("rewrites the size-code prefix to the small (64²) rendition", () => {
    expect(spotifyAlbumImageAtSize(stored, "small")).toBe(
      `https://i.scdn.co/image/ab67616d00004851${HASH}`,
    );
  });

  it("rewrites to the large (640²) rendition", () => {
    expect(spotifyAlbumImageAtSize(stored, "large")).toBe(
      `https://i.scdn.co/image/ab67616d0000b273${HASH}`,
    );
  });

  it("rewrites to the medium (300²) rendition", () => {
    expect(spotifyAlbumImageAtSize(stored, "medium")).toBe(
      `https://i.scdn.co/image/ab67616d00001e02${HASH}`,
    );
  });

  it("re-sizes whatever source code is stored, not just the 300² variant", () => {
    const big = `https://i.scdn.co/image/ab67616d0000b273${HASH}`;
    expect(spotifyAlbumImageAtSize(big, "small")).toBe(
      `https://i.scdn.co/image/ab67616d00004851${HASH}`,
    );
  });

  it("passes a non-Spotify URL through untouched", () => {
    const deezer = "https://e-cdns-images.dzcdn.net/images/cover/abc/250x250-000000-80-0-0.jpg";
    expect(spotifyAlbumImageAtSize(deezer, "small")).toBe(deezer);
  });

  it("passes an unparseable Spotify URL through untouched", () => {
    const odd = "https://i.scdn.co/image/not-a-cover-id";
    expect(spotifyAlbumImageAtSize(odd, "small")).toBe(odd);
  });

  it("returns undefined for an undefined input", () => {
    expect(spotifyAlbumImageAtSize(undefined, "small")).toBeUndefined();
  });
});

// trackMedia() must keep returning the RAW masters: admin, OG tags, and JSON-LD
// all read it and must never be handed an edge-transform URL.
describe("trackMedia (unchanged contract)", () => {
  it("returns raw master URLs, never /cdn-cgi/media transforms", () => {
    const media = trackMedia("ABC123");

    expect(media.videoUrl).toBe(`${FOUND_BASE}/ABC123/footage.mp4`);
    expect(media.posterUrl).toBe(`${FOUND_BASE}/ABC123/poster.jpg`);
    expect(media.videoUrl).not.toContain("/cdn-cgi/media");
    expect(media.posterUrl).not.toContain("/cdn-cgi/media");
  });
});
