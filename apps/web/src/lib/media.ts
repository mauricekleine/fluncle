// R2 media for a finding, keyed by its Log ID.
//
// The Worker owns the bucket; these are the public read URLs on the
// found.fluncle.com custom domain. The video bundle (footage / footage-silent /
// poster / cover / …) is stored at `<log-id>/<name>` — only `footage.mp4` gets a
// DB column (`video_url`); cover, poster, and the silent cut live by CONVENTION,
// with no column. This module is the single source of that convention for every
// surface (the feed, Stories, OG tags), so the `<log-id>/<name>` shape is written
// down once instead of re-encoded per caller.

export const FOUND_BASE = "https://found.fluncle.com";

/** The mixtape's episode audio on R2 (the podcast enclosure), by its Log ID. */
export function mixtapeAudioUrl(logId: string): string {
  return `${FOUND_BASE}/${encodeURIComponent(logId)}/mixtape.m4a`;
}

export type TrackMedia = {
  /** The profile-grid cover: loud centered identity. Also the OG image + video loading still. */
  coverUrl: string;
  /** The fixed-template caption (Fluncle's voice) — what the operator pastes in-app. */
  noteUrl: string;
  /** Fluncle's spoken field observation (the recovered-audio artifact). */
  observationAudioUrl: string;
  /** The spoken observation's text (re-render source; may render under the /log audio control). */
  observationTextUrl: string;
  /** The structured observation artifact + render metadata (provenance; internal). */
  observationJsonUrl: string;
  /** A late drop frame; the video element's poster. */
  posterUrl: string;
  /**
   * The stored `video_url` master. Under the two-master layout (videoSquaredAt
   * set) this is the CLEAN square 1920×1920 crop source; under the legacy layout
   * it is the old portrait+text cut. Surfaces choose by the layout signal.
   */
  videoUrl: string;
  /**
   * The portrait, baked-text social cut (footage.social.mp4): the playable cut
   * for Stories + YouTube, and (audio-stripped via MT) TikTok. Present once a
   * finding has any video — new renders ship it, and the migration backfills it
   * for legacy findings. Surfaces fall back to `videoUrl` when it's absent.
   */
  socialVideoUrl: string;
  /** The audio-less cut — what Stories plays muted, since sound is the official preview. */
  silentVideoUrl: string;
};

/** Derive the conventional R2 media URLs for a finding from its Log ID. */
export function trackMedia(logId: string): TrackMedia {
  const base = `${FOUND_BASE}/${encodeURIComponent(logId)}`;

  return {
    coverUrl: `${base}/cover.jpg`,
    noteUrl: `${base}/note.txt`,
    observationAudioUrl: `${base}/observation.mp3`,
    observationJsonUrl: `${base}/observation.json`,
    observationTextUrl: `${base}/observation.txt`,
    posterUrl: `${base}/poster.jpg`,
    silentVideoUrl: `${base}/footage-silent.mp4`,
    socialVideoUrl: `${base}/footage.social.mp4`,
    videoUrl: `${base}/footage.mp4`,
  };
}

// ── Spotify album-art renditions ─────────────────────────────────────────────
//
// `album_image_url` stores a Spotify CDN URL (i.scdn.co). Spotify encodes the
// pixel size in the image-id PREFIX, not query params: `ab67616d0000b273` = 640²,
// `ab67616d00001e02` = 300², `ab67616d00004851` = 64². We store the 300² variant
// (selectAlbumImageUrl picks width >= 300), which is a ~20 KB JPEG — far too heavy
// for a 52px feed row. Swapping the prefix requests a right-sized rendition of the
// SAME cover (64² ≈ 2.7 KB for a row, 640² for the full-bleed /log poster). Any
// non-Spotify or unrecognized URL passes through untouched.

const SPOTIFY_IMAGE_SIZE_CODE = {
  large: "ab67616d0000b273", // 640²
  medium: "ab67616d00001e02", // 300²
  small: "ab67616d00004851", // 64²
} as const;

export type SpotifyImageSize = keyof typeof SPOTIFY_IMAGE_SIZE_CODE;

// The Spotify album-art id is the 16-char size code + a 24-char (hex) cover hash.
const SPOTIFY_ALBUM_IMAGE_RE = /^(https:\/\/i\.scdn\.co\/image\/)ab67616d[0-9a-f]{8}([0-9a-f]+)$/;

/**
 * Rewrite a stored Spotify album-art URL to the requested rendition size, leaving
 * any non-Spotify URL (or unparseable id) untouched. `small` for the feed/index
 * rows, `large` for the full-bleed /log poster (the stored 300² would upscale).
 */
export function spotifyAlbumImageAtSize(
  url: string | undefined,
  size: SpotifyImageSize,
): string | undefined {
  if (!url) {
    return url;
  }

  const match = SPOTIFY_ALBUM_IMAGE_RE.exec(url);

  if (!match) {
    return url;
  }

  return `${match[1]}${SPOTIFY_IMAGE_SIZE_CODE[size]}${match[2]}`;
}

// ── Cloudflare Media Transformations ─────────────────────────────────────────
//
// Playback surfaces (Stories, the log footage) don't fetch the raw 1080×1920
// master — that's a heavy file on a phone over cellular. Instead they request a
// same-zone Media Transformations rendition: Cloudflare resizes/transcodes the
// master on the edge and caches it. The master keeps being the source of truth
// (admin, OG, JSON-LD all read `trackMedia()` untouched); these helpers only
// build the transform URL that points BACK at that master.
//
// URL shape (https://developers.cloudflare.com/stream/transform-videos/):
//   https://<zone>/cdn-cgi/media/<OPTIONS>/<SOURCE-URL>
// `<zone>` must be the fluncle.com zone with Transformations enabled (an
// operator step — see wrangler.jsonc). The source is the master on the SAME
// zone (found.fluncle.com), so the transform never crosses an origin.
//
// Constraints worth remembering: the source must be a full https URL, and
// Cloudflare rejects sources larger than 100MB. Stragglers above that ceiling
// (or any edge error) fall back to the raw master via a one-shot `onError` on
// the <video>/<img>, so playback is safe regardless of the transform's verdict.

/** The /cdn-cgi/media base on the found.fluncle.com zone (same zone as the master). */
const MEDIA_TRANSFORM_BASE = `${FOUND_BASE}/cdn-cgi/media`;

/**
 * The intrinsic width Cloudflare transcodes a rendition to. The list is sparse
 * on purpose — each distinct width is a separately-cached transform, so we snap
 * the viewport to a small ladder instead of minting a per-pixel rendition.
 */
export type RenditionWidth = 360 | 480 | 720 | 1080;

/**
 * Build a same-zone Media Transformations URL for a footage rendition.
 *
 * `mode=video,width=N` resizes the master's `footage.mp4` to `width` px wide
 * (height follows the source aspect), transcoded and cached at Cloudflare's
 * edge. Falls back to the raw master on any edge error via the caller's
 * one-shot `onError`.
 */
export function videoRendition(
  logId: string,
  { master = "footage.mp4", width }: { master?: string; width: RenditionWidth },
): string {
  const source = `${FOUND_BASE}/${encodeURIComponent(logId)}/${master}`;

  return `${MEDIA_TRANSFORM_BASE}/mode=video,width=${width}/${source}`;
}

/**
 * Build a same-zone Media Transformations URL for a cheap poster frame.
 *
 * `mode=frame` pulls a single still from the master instead of shipping the
 * 1080-wide `poster.jpg`; `time=0s,format=jpg` takes the opening frame as a
 * JPEG. Used as the <video> poster so the first paint is a light edge-cached
 * image, not the full poster asset.
 */
export function videoPoster(logId: string, master = "footage.mp4"): string {
  const source = `${FOUND_BASE}/${encodeURIComponent(logId)}/${master}`;

  return `${MEDIA_TRANSFORM_BASE}/mode=frame,time=0s,format=jpg/${source}`;
}

// ── Two-master crops (docs/video-variants.md) ────────────────────────────────
//
// Under the two-master layout (videoSquaredAt set), `footage.mp4` is the CLEAN
// square 1920×1920 source master. The archive surfaces (/log, radio) never play
// the square — they request an on-the-fly MT centre-crop to the orientation the
// viewport wants. `fit=crop` is a CENTRE crop, so a 1920×1920 master yields both
// a native-resolution 1080×1920 portrait and 1920×1080 landscape with no upscale
// (only the centre "plus" of the square is ever seen — compositions destined to
// be cropped keep their centre of gravity centered). These ONLY apply when the
// finding carries the square master; a legacy finding still plays `footage.mp4`
// as-is, so callers gate on `videoSquaredAt` before reaching for a crop.

/** Crop orientation for the square master: portrait (mobile) or landscape (desktop). */
export type CropOrientation = "landscape" | "portrait";

const CROP_DIMENSIONS: Record<CropOrientation, { height: number; width: number }> = {
  // 16:9 full-screen radio/desktop; 9:16 mobile. Both native off the 1920² square.
  landscape: { height: 1080, width: 1920 },
  portrait: { height: 1080 * (16 / 9), width: 1080 },
};

/**
 * Build a same-zone Media Transformations URL that CENTRE-CROPS the square
 * `footage.mp4` master to `orientation`. `fit=crop,width=W,height=H` resizes +
 * crops in one op; the result is edge-cached like the resolution-ladder
 * renditions. Only valid for a finding under the two-master layout (its
 * `footage.mp4` is the clean square) — callers gate on `videoSquaredAt`.
 */
export function videoCrop(logId: string, orientation: CropOrientation): string {
  const source = `${FOUND_BASE}/${encodeURIComponent(logId)}/footage.mp4`;
  const { height, width } = CROP_DIMENSIONS[orientation];

  return `${MEDIA_TRANSFORM_BASE}/fit=crop,width=${width},height=${height}/${source}`;
}

/**
 * Strip the audio track from any same-zone master via `audio=false`. The TikTok
 * push reaches for this off `footage.social.mp4` so the operator attaches the
 * licensed sound in-app — replacing the stored `footage-silent.mp4` cut, which
 * is retired under the two-master model. `source` must be a full found.fluncle.com
 * URL (same zone as the transform base).
 */
export function videoAudioStripped(source: string): string {
  return `${MEDIA_TRANSFORM_BASE}/audio=false/${source}`;
}
