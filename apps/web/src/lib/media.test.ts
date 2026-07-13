import { describe, expect, it } from "vitest";
import {
  FOUND_BASE,
  albumCoverAtSize,
  bestAlbumCoverUrl,
  bestArtistAvatarUrl,
  ownedCoverUrl,
  trackMedia,
  versionedObservationAudioUrl,
  videoAudioStripped,
  videoClipCrop,
  videoCrop,
  videoCropPoster,
  videoPoster,
  videoPurgeUrls,
  videoRendition,
  videoVersion,
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
    // Masters are overwritten in place (the square
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

// The two-master crops + audio-strip. The square master
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

  it("folds audio=false into the SAME transform when silent (radio — never nested, one ?v)", () => {
    // radio plays the observation over a silent cut. The crop + strip MUST be one
    // combined transform; `videoAudioStripped(videoCrop(...))` nests a transform in
    // a transform (Cloudflare 400s it) and double-appends `?v`. Verified 200 live.
    const url = videoCrop("ABC123", "landscape", undefined, true);
    expect(url).toBe(
      `${FOUND_BASE}/cdn-cgi/media/fit=cover,width=1920,height=1080,audio=false/${FOUND_BASE}/ABC123/footage.mp4?v=1`,
    );
    expect(url.match(/cdn-cgi\/media/g)).toHaveLength(1); // one transform, not nested
    expect(url.match(/\?v=/g)).toHaveLength(1); // one version token, not doubled
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

  it("defaults to the opening frame (time=0s) — the /log + radio-head behavior unchanged", () => {
    expect(videoCropPoster("ABC123", "portrait")).toContain("time=0s");
  });

  it("threads the offset frame for a mid-segment joiner (the shared-broadcast poster)", () => {
    // A joiner 40s in must see the 40s still, not the opening frame, or the
    // poster→video swap visibly jumps. The offset floors to whole seconds.
    expect(videoCropPoster("ABC123", "landscape", undefined, 40)).toBe(
      `${FOUND_BASE}/cdn-cgi/media/fit=cover,width=1920,height=1080,mode=frame,time=40s,format=jpg/${FOUND_BASE}/ABC123/footage.mp4?v=1`,
    );
    expect(videoCropPoster("ABC123", "portrait", 720, 12.9)).toContain("time=12s");
  });

  it("never emits a negative time", () => {
    expect(videoCropPoster("ABC123", "portrait", undefined, -5)).toContain("time=0s");
  });
});

// The fast offset-join clip (the radio-broadcast RFC Unit B). CF MT `mode=video`
// `time=`/`duration=` returns a faststart rendition that BEGINS at the global
// offset (verified live: time=5s,duration=10s → 200, ~7MB faststart, edge-cached).
// Crop + audio-strip + clip are ONE combined transform, never nested.
describe("videoClipCrop", () => {
  it("builds one combined crop+strip+clip beginning at the offset (landscape)", () => {
    expect(videoClipCrop("ABC123", "landscape", 40, undefined, 20)).toBe(
      `${FOUND_BASE}/cdn-cgi/media/fit=cover,width=1920,height=1080,audio=false,time=40s,duration=20s/${FOUND_BASE}/ABC123/footage.mp4?v=1`,
    );
  });

  it("derives the portrait height from the 16/9 ratio at a ladder width", () => {
    expect(videoClipCrop("ABC123", "portrait", 10, 720, 30)).toBe(
      `${FOUND_BASE}/cdn-cgi/media/fit=cover,width=720,height=1280,audio=false,time=10s,duration=30s/${FOUND_BASE}/ABC123/footage.mp4?v=1`,
    );
  });

  it("is ONE transform, never nested, with a single ?v (the no-nesting rule)", () => {
    const url = videoClipCrop("ABC123", "landscape", 40);
    expect(url.match(/cdn-cgi\/media/g)).toHaveLength(1);
    expect(url.match(/\?v=/g)).toHaveLength(1);
    expect(url).toContain("audio=false");
  });

  it("defaults the duration to the 60s MT max", () => {
    expect(videoClipCrop("ABC123", "landscape", 40)).toContain("duration=60s");
  });

  it("clamps the duration into the CF MT [1, 60] window", () => {
    expect(videoClipCrop("ABC123", "landscape", 40, undefined, 120)).toContain("duration=60s");
    expect(videoClipCrop("ABC123", "landscape", 40, undefined, 0)).toContain("duration=1s");
  });

  it("floors the start to whole seconds and never goes negative", () => {
    expect(videoClipCrop("ABC123", "landscape", 12.9)).toContain("time=12s");
    expect(videoClipCrop("ABC123", "landscape", -5)).toContain("time=0s");
  });

  it("rides the cache-bust token so a re-rendered master re-keys the clip", () => {
    expect(videoClipCrop("ABC123", "landscape", 40)).toContain("/footage.mp4?v=");
  });

  it("encodes the Log ID in the source URL", () => {
    expect(videoClipCrop("a/b c", "portrait", 10)).toContain(`${FOUND_BASE}/a%2Fb%20c/footage.mp4`);
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
describe("albumCoverAtSize", () => {
  const HASH = "18c0fd64aad5d4fb51a499b0";
  const stored = `https://i.scdn.co/image/ab67616d00001e02${HASH}`; // the 300² we store

  it("rewrites the size-code prefix to the small (64²) rendition", () => {
    expect(albumCoverAtSize(stored, "small")).toBe(
      `https://i.scdn.co/image/ab67616d00004851${HASH}`,
    );
  });

  it("rewrites to the large (640²) rendition", () => {
    expect(albumCoverAtSize(stored, "large")).toBe(
      `https://i.scdn.co/image/ab67616d0000b273${HASH}`,
    );
  });

  it("rewrites to the medium (300²) rendition", () => {
    expect(albumCoverAtSize(stored, "medium")).toBe(
      `https://i.scdn.co/image/ab67616d00001e02${HASH}`,
    );
  });

  it("re-sizes whatever source code is stored, not just the 300² variant", () => {
    const big = `https://i.scdn.co/image/ab67616d0000b273${HASH}`;
    expect(albumCoverAtSize(big, "small")).toBe(`https://i.scdn.co/image/ab67616d00004851${HASH}`);
  });

  it("passes a non-Spotify URL through untouched", () => {
    const deezer = "https://e-cdns-images.dzcdn.net/images/cover/abc/250x250-000000-80-0-0.jpg";
    expect(albumCoverAtSize(deezer, "small")).toBe(deezer);
  });

  it("passes an unparseable Spotify URL through untouched", () => {
    const odd = "https://i.scdn.co/image/not-a-cover-id";
    expect(albumCoverAtSize(odd, "small")).toBe(odd);
  });

  it("returns undefined for an undefined input", () => {
    expect(albumCoverAtSize(undefined, "small")).toBeUndefined();
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

// The re-render purge set must mirror the builders above EXACTLY — a width the
// surfaces request but the set omits stays stale; a width never requested is
// wasted purge budget. These tests pin the set against the very builders it
// shadows, so a future change to a builder that isn't reflected here fails.
describe("videoPurgeUrls", () => {
  const LOG_ID = "004.7.2I";

  it("always includes both R2 masters and the audio-stripped social cut", () => {
    const media = trackMedia(LOG_ID);

    for (const squared of [true, false]) {
      const urls = videoPurgeUrls(LOG_ID, { squared });

      expect(urls).toContain(media.videoUrl);
      expect(urls).toContain(media.socialVideoUrl);
      expect(urls).toContain(videoAudioStripped(media.socialVideoUrl));
    }
  });

  it("always includes the bundle's static images (the agents' diversity-check reads)", () => {
    const media = trackMedia(LOG_ID);

    for (const squared of [true, false]) {
      const urls = videoPurgeUrls(LOG_ID, { squared });

      expect(urls).toContain(media.posterUrl);
      expect(urls).toContain(media.coverUrl);
    }
  });

  it("returns a de-duplicated set (no URL listed twice)", () => {
    for (const squared of [true, false]) {
      const urls = videoPurgeUrls(LOG_ID, { squared });

      expect(new Set(urls).size).toBe(urls.length);
    }
  });

  it("legacy: every ladder rendition off footage.mp4 plus the opening poster", () => {
    const urls = videoPurgeUrls(LOG_ID, { squared: false });

    for (const width of [360, 480, 720, 1080] as const) {
      expect(urls).toContain(videoRendition(LOG_ID, { width }));
    }

    expect(urls).toContain(videoPoster(LOG_ID));
  });

  it("legacy: does NOT include the square-crop renditions", () => {
    const urls = videoPurgeUrls(LOG_ID, { squared: false });

    expect(urls).not.toContain(videoCrop(LOG_ID, "portrait"));
    expect(urls).not.toContain(videoCrop(LOG_ID, "landscape"));
  });

  it("squared: includes both orientations × ladder + native crops, silent + poster", () => {
    const urls = videoPurgeUrls(LOG_ID, { squared: true });

    for (const orientation of ["landscape", "portrait"] as const) {
      // native crop (no explicit width), silent loop, and opening poster
      expect(urls).toContain(videoCrop(LOG_ID, orientation));
      expect(urls).toContain(videoCrop(LOG_ID, orientation, undefined, true));
      expect(urls).toContain(videoCropPoster(LOG_ID, orientation));

      for (const width of [360, 480, 720, 1080] as const) {
        expect(urls).toContain(videoCrop(LOG_ID, orientation, width));
        expect(urls).toContain(videoCrop(LOG_ID, orientation, width, true));
        expect(urls).toContain(videoCropPoster(LOG_ID, orientation, width));
      }
    }
  });

  it("squared: does NOT include the legacy width-ladder renditions", () => {
    const urls = videoPurgeUrls(LOG_ID, { squared: true });

    expect(urls).not.toContain(videoRendition(LOG_ID, { width: 720 }));
    expect(urls).not.toContain(videoPoster(LOG_ID));
  });

  it("stays within two Cloudflare purge requests (the helper chunks at 30 URLs)", () => {
    // The squared family is the larger set: 30 video/rendition URLs + the two
    // bundle images (poster.jpg/cover.jpg) = 32, i.e. exactly two chunks. Keep it
    // from creeping past that — a purge should stay a couple of requests, not a fan-out.
    expect(videoPurgeUrls(LOG_ID, { squared: true }).length).toBeLessThanOrEqual(60);
    expect(videoPurgeUrls(LOG_ID, { squared: true }).length).toBe(32);
  });
});

describe("videoVersion (the transform vintage token)", () => {
  const STAMP = "2026-07-02T08:00:30.940Z";
  const EPOCH = Date.parse(STAMP);

  it("parses a videoSquaredAt/updatedAt stamp to its epoch", () => {
    expect(videoVersion(STAMP)).toBe(EPOCH);
  });

  it("is undefined (-> the constant token) for absent or garbage stamps", () => {
    expect(videoVersion(undefined)).toBeUndefined();
    expect(videoVersion(null)).toBeUndefined();
    expect(videoVersion("")).toBeUndefined();
    expect(videoVersion("not-a-date")).toBeUndefined();
  });

  it("rides every transform source as ?v=<epoch>; absent keeps the constant", () => {
    expect(videoCrop("004.7.2I", "portrait", 720, false, EPOCH)).toContain(`?v=${EPOCH}`);
    expect(videoCrop("004.7.2I", "portrait", 720)).toContain("?v=1");
    expect(videoCropPoster("004.7.2I", "portrait", 720, 0, EPOCH)).toContain(`?v=${EPOCH}`);
    expect(videoRendition("004.7.2I", { version: EPOCH, width: 720 })).toContain(`?v=${EPOCH}`);
    expect(videoPoster("004.7.2I", undefined, EPOCH)).toContain(`?v=${EPOCH}`);
    expect(videoClipCrop("004.7.2I", "portrait", 5, undefined, 60, EPOCH)).toContain(`?v=${EPOCH}`);
    expect(videoAudioStripped(`${FOUND_BASE}/004.7.2I/footage.social.mp4`, EPOCH)).toContain(
      `?v=${EPOCH}`,
    );
  });

  it("videoPurgeUrls carries the vintage on every transform and never on bare objects", () => {
    const media = trackMedia("004.7.2I");
    const urls = videoPurgeUrls("004.7.2I", { squared: true, version: EPOCH });
    const transforms = urls.filter((u) => u.includes("/cdn-cgi/media/"));
    const bare = urls.filter((u) => !u.includes("/cdn-cgi/media/"));

    expect(transforms.length).toBeGreaterThan(0);

    for (const u of transforms) {
      expect(u).toContain(`?v=${EPOCH}`);
    }

    for (const u of bare) {
      expect(u).not.toContain("?v=");
    }

    expect(bare).toContain(media.videoUrl);
    expect(bare).toContain(media.posterUrl);
  });
});

// ── Owned cover masters (RFC U3b) ────────────────────────────────────────────

const KEY = "albums/some-album.jpg";

describe("ownedCoverUrl — Cloudflare Images transform", () => {
  it("builds a /cdn-cgi/image URL at the requested rung, ?v riding the source", () => {
    const url = ownedCoverUrl(KEY, "2026-07-13T00:00:00.000Z", "large");
    const v = Date.parse("2026-07-13T00:00:00.000Z");

    expect(url).toBe(
      `${FOUND_BASE}/cdn-cgi/image/width=640,format=auto/${FOUND_BASE}/albums/some-album.jpg?v=${v}`,
    );
  });

  it("maps each ladder rung to its width", () => {
    expect(ownedCoverUrl(KEY, "x", "small")).toContain("width=64,");
    expect(ownedCoverUrl(KEY, "x", "medium")).toContain("width=300,");
    expect(ownedCoverUrl(KEY, "x", "xl")).toContain("width=1200,");
  });

  it("returns undefined when there is no owned master", () => {
    expect(ownedCoverUrl(null, "x", "large")).toBeUndefined();
  });

  it("busts the rendition cache when the vintage changes (the ?v bust)", () => {
    const a = ownedCoverUrl(KEY, "2026-07-13T00:00:00.000Z", "large");
    const b = ownedCoverUrl(KEY, "2026-07-14T00:00:00.000Z", "large");

    expect(a).not.toBe(b);
  });
});

describe("albumCoverAtSize — resizes BOTH providers", () => {
  it("rewrites an owned-master transform width to the requested rung", () => {
    const large = ownedCoverUrl(KEY, "2026-07-13T00:00:00.000Z", "large");

    expect(albumCoverAtSize(large, "small")).toContain("width=64,");
    // The ?v bust survives the resize (it rides the source, past the options).
    expect(albumCoverAtSize(large, "small")).toContain("?v=");
  });

  it("still swaps a Spotify album-art prefix (xl clamps to 640)", () => {
    const spotify = "https://i.scdn.co/image/ab67616d00001e02cafef00d";

    expect(albumCoverAtSize(spotify, "small")).toBe(
      "https://i.scdn.co/image/ab67616d00004851cafef00d",
    );
    expect(albumCoverAtSize(spotify, "xl")).toBe(
      "https://i.scdn.co/image/ab67616d0000b273cafef00d",
    );
  });

  it("passes a non-provider URL (a raw artist avatar) through untouched", () => {
    const avatar = "https://i.scdn.co/image/ab6761610000e5ebcafe";

    expect(albumCoverAtSize(avatar, "small")).toBe(avatar);
  });
});

describe("bestAlbumCoverUrl — owned master preferred, Spotify floor", () => {
  it("serves the owned master (640) when the album resolved one", () => {
    const url = bestAlbumCoverUrl({
      imageKey: KEY,
      imageState: "resolved",
      imageUpdatedAt: "2026-07-13T00:00:00.000Z",
      spotifyUrl: "https://i.scdn.co/image/ab67616d00001e02cafe",
    });

    expect(url).toContain("/cdn-cgi/image/width=640,");
  });

  it("falls through to the Spotify 640 chain when there is no owned master", () => {
    const url = bestAlbumCoverUrl({
      imageKey: null,
      imageState: "pending",
      imageUpdatedAt: null,
      spotifyUrl: "https://i.scdn.co/image/ab67616d00001e02cafe",
    });

    expect(url).toBe("https://i.scdn.co/image/ab67616d0000b273cafe");
  });
});

describe("bestArtistAvatarUrl — owned master preferred, raw avatar floor", () => {
  it("serves the owned master when resolved", () => {
    const url = bestArtistAvatarUrl({
      imageKey: "artists/some-artist.jpg",
      imageState: "resolved",
      imageUpdatedAt: "2026-07-13T00:00:00.000Z",
      imageUrl: "https://i.scdn.co/image/ab6761610000e5ebcafe",
    });

    expect(url).toContain("/cdn-cgi/image/width=640,format=auto/");
    expect(url).toContain("artists/some-artist.jpg");
  });

  it("falls back to the raw Spotify avatar when unowned", () => {
    const raw = "https://i.scdn.co/image/ab6761610000e5ebcafe";
    const url = bestArtistAvatarUrl({
      imageKey: null,
      imageState: "pending",
      imageUpdatedAt: null,
      imageUrl: raw,
    });

    expect(url).toBe(raw);
  });
});
