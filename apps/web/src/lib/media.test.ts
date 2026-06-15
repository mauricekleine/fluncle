import { describe, expect, it } from "vitest";
import { FOUND_BASE, trackMedia, videoPoster, videoRendition } from "./media";

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
