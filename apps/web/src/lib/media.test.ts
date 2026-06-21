import { describe, expect, it } from "vitest";
import {
  FOUND_BASE,
  spotifyAlbumImageAtSize,
  trackMedia,
  versionedObservationAudioUrl,
  videoAudioStripped,
  videoCrop,
  videoCropPoster,
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
      `${FOUND_BASE}/cdn-cgi/media/mode=video,width=720/${FOUND_BASE}/ABC123/footage.mp4?v=1`,
    );
  });

  it("rides the cache-bust token on the source so a re-rendered master re-keys the edge rendition", () => {
    // docs/video-variants.md: masters are overwritten in place (the square
    // backfill), so the transform URL must carry a version or the edge keeps
    // serving the stale rendition. Guard that the token is never silently dropped.
    expect(videoRendition("ABC123", { width: 720 })).toContain("/footage.mp4?v=");
  });

  it("carries the requested rung into the width option", () => {
    expect(videoRendition("ABC123", { width: 360 })).toContain("mode=video,width=360/");
    expect(videoRendition("ABC123", { width: 1080 })).toContain("mode=video,width=1080/");
  });

  it("encodes the Log ID in the source URL", () => {
    expect(videoRendition("a/b c", { width: 480 })).toBe(
      `${FOUND_BASE}/cdn-cgi/media/mode=video,width=480/${FOUND_BASE}/a%2Fb%20c/footage.mp4?v=1`,
    );
  });

  it("targets the same master that trackMedia() returns", () => {
    const logId = "ABC123";
    expect(videoRendition(logId, { width: 720 })).toContain(trackMedia(logId).videoUrl);
  });

  it("points the rendition at the social cut when that master is named (Stories two-master)", () => {
    expect(videoRendition("ABC123", { master: "footage.social.mp4", width: 720 })).toBe(
      `${FOUND_BASE}/cdn-cgi/media/mode=video,width=720/${FOUND_BASE}/ABC123/footage.social.mp4?v=1`,
    );
  });
});

// The two-master crops + audio-strip (docs/video-variants.md). The square master
// centre-crops to native-resolution portrait/landscape; TikTok strips audio off
// the social cut via audio=false rather than a stored footage-silent.mp4.
describe("videoCrop", () => {
  it("builds a centre-crop to portrait off the square master", () => {
    expect(videoCrop("ABC123", "portrait")).toBe(
      `${FOUND_BASE}/cdn-cgi/media/fit=cover,width=1080,height=1920/${FOUND_BASE}/ABC123/footage.mp4?v=1`,
    );
  });

  it("builds a centre-crop to landscape off the square master", () => {
    expect(videoCrop("ABC123", "landscape")).toBe(
      `${FOUND_BASE}/cdn-cgi/media/fit=cover,width=1920,height=1080/${FOUND_BASE}/ABC123/footage.mp4?v=1`,
    );
  });

  it("encodes the Log ID in the source URL", () => {
    expect(videoCrop("a/b c", "portrait")).toContain(`${FOUND_BASE}/a%2Fb%20c/footage.mp4`);
  });

  it("snaps the crop to a ladder width, deriving height from the portrait aspect (16/9)", () => {
    // Stories sizes the crop to the measured pane (a 720-rung phone), not the
    // native 1080. Height follows the 16/9 portrait ratio: round(720 * 16/9) = 1280.
    expect(videoCrop("ABC123", "portrait", 720)).toBe(
      `${FOUND_BASE}/cdn-cgi/media/fit=cover,width=720,height=1280/${FOUND_BASE}/ABC123/footage.mp4?v=1`,
    );
  });

  it("derives the landscape height from the 9/16 ratio at a requested width", () => {
    // round(1280 * 9/16) = 720.
    expect(videoCrop("ABC123", "landscape", 1280)).toBe(
      `${FOUND_BASE}/cdn-cgi/media/fit=cover,width=1280,height=720/${FOUND_BASE}/ABC123/footage.mp4?v=1`,
    );
  });

  it("falls back to the native width when none is given (the /log caller is unchanged)", () => {
    expect(videoCrop("ABC123", "portrait")).toBe(videoCrop("ABC123", "portrait", 1080));
    expect(videoCrop("ABC123", "landscape")).toBe(videoCrop("ABC123", "landscape", 1920));
  });
});

// The squared poster twin: a single opening frame, centre-cropped to the same
// orientation as videoCrop (Cloudflare MT accepts fit=cover + mode=frame —
// verified 200 on a live portrait crop), so the squared <video> poster matches
// the cropped clip instead of a square loading frame.
describe("videoCropPoster", () => {
  it("builds a fit=cover + mode=frame portrait poster off the square master", () => {
    expect(videoCropPoster("ABC123", "portrait")).toBe(
      `${FOUND_BASE}/cdn-cgi/media/fit=cover,width=1080,height=1920,mode=frame,time=0s,format=jpg/${FOUND_BASE}/ABC123/footage.mp4?v=1`,
    );
  });

  it("snaps to a ladder width with height from the portrait aspect", () => {
    expect(videoCropPoster("ABC123", "portrait", 720)).toBe(
      `${FOUND_BASE}/cdn-cgi/media/fit=cover,width=720,height=1280,mode=frame,time=0s,format=jpg/${FOUND_BASE}/ABC123/footage.mp4?v=1`,
    );
  });

  it("rides the cache-bust token so a re-rendered master re-keys the poster", () => {
    expect(videoCropPoster("ABC123", "portrait")).toContain("/footage.mp4?v=");
  });

  it("encodes the Log ID in the source URL", () => {
    expect(videoCropPoster("a/b c", "portrait")).toContain(`${FOUND_BASE}/a%2Fb%20c/footage.mp4`);
  });
});

describe("videoAudioStripped", () => {
  it("strips audio at the native 1080 portrait width (≥720p for TikTok)", () => {
    const source = `${FOUND_BASE}/ABC123/footage.social.mp4`;
    expect(videoAudioStripped(source)).toBe(
      `${FOUND_BASE}/cdn-cgi/media/mode=video,audio=false,width=1080/${source}?v=1`,
    );
  });

  // audio=false ALONE collapses to Cloudflare MT's ~202px default — a sub-720p
  // cut TikTok rejects. The width is the load-bearing part of the fix, so pin it.
  it("requests an explicit width so the rendition is never the degenerate MT default", () => {
    const source = `${FOUND_BASE}/ABC123/footage.social.mp4`;
    expect(videoAudioStripped(source)).toContain("width=1080");
  });
});

describe("videoPoster", () => {
  it("builds a same-zone mode=frame transform for a cheap opening still", () => {
    expect(videoPoster("ABC123")).toBe(
      `${FOUND_BASE}/cdn-cgi/media/mode=frame,time=0s,format=jpg/${FOUND_BASE}/ABC123/footage.mp4?v=1`,
    );
  });

  it("encodes the Log ID in the source URL", () => {
    expect(videoPoster("a/b c")).toBe(
      `${FOUND_BASE}/cdn-cgi/media/mode=frame,time=0s,format=jpg/${FOUND_BASE}/a%2Fb%20c/footage.mp4?v=1`,
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
    expect(media.socialVideoUrl).toBe(`${FOUND_BASE}/ABC123/footage.social.mp4`);
    expect(media.posterUrl).toBe(`${FOUND_BASE}/ABC123/poster.jpg`);
    expect(media.videoUrl).not.toContain("/cdn-cgi/media");
    expect(media.socialVideoUrl).not.toContain("/cdn-cgi/media");
    expect(media.posterUrl).not.toContain("/cdn-cgi/media");
  });

  it("returns the BARE observation audio URL (the admin-overwrite source of truth)", () => {
    // trackMedia is keyed by the logId alone (no render timestamp), so it stays
    // the raw URL — the observe route reads it to PUT the object, and the DTO
    // versions it for playback. It must never carry a ?v= here.
    expect(trackMedia("ABC123").observationAudioUrl).toBe(`${FOUND_BASE}/ABC123/observation.mp3`);
    expect(trackMedia("ABC123").observationAudioUrl).not.toContain("?v=");
  });
});

// The playback/consumer observation URL is versioned by observation_generated_at
// so a re-`observe` (which overwrites observation.mp3 in place at the same R2 key)
// re-keys the edge cache — the bare URL alone HITs stale until its max-age TTL.
describe("versionedObservationAudioUrl", () => {
  const bare = `${FOUND_BASE}/ABC123/observation.mp3`;

  it("appends ?v=<epoch-ms of generatedAt> to the bare URL", () => {
    const generatedAt = "2026-06-21T10:00:00.000Z";
    expect(versionedObservationAudioUrl(bare, generatedAt)).toBe(
      `${bare}?v=${Date.parse(generatedAt)}`,
    );
  });

  it("CHANGES the URL when observation_generated_at changes (a re-observe re-keys the cache)", () => {
    const before = versionedObservationAudioUrl(bare, "2026-06-21T10:00:00.000Z");
    const after = versionedObservationAudioUrl(bare, "2026-06-21T12:30:00.000Z");

    expect(before).not.toBe(after);
    expect(before).toContain("?v=");
    expect(after).toContain("?v=");
  });

  it("returns undefined for a finding with no observation (no broken URL)", () => {
    expect(versionedObservationAudioUrl(undefined, "2026-06-21T10:00:00.000Z")).toBeUndefined();
  });

  it("returns the bare URL unchanged when no timestamp is present (no dangling ?v=)", () => {
    expect(versionedObservationAudioUrl(bare, undefined)).toBe(bare);
    expect(versionedObservationAudioUrl(bare, undefined)).not.toContain("?v=");
  });

  it("returns the bare URL unchanged when the timestamp is unparseable", () => {
    expect(versionedObservationAudioUrl(bare, "not-a-date")).toBe(bare);
  });
});
