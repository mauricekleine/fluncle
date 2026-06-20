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
  /** The with-audio review cut (matches the stored `video_url`). */
  videoUrl: string;
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
    videoUrl: `${base}/footage.mp4`,
  };
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
export function videoRendition(logId: string, { width }: { width: RenditionWidth }): string {
  const source = `${FOUND_BASE}/${encodeURIComponent(logId)}/footage.mp4`;

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
export function videoPoster(logId: string): string {
  const source = `${FOUND_BASE}/${encodeURIComponent(logId)}/footage.mp4`;

  return `${MEDIA_TRANSFORM_BASE}/mode=frame,time=0s,format=jpg/${source}`;
}
