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

export type TrackMedia = {
  /** The profile-grid cover: loud centered identity. Also the OG image + video loading still. */
  coverUrl: string;
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
    posterUrl: `${base}/poster.jpg`,
    silentVideoUrl: `${base}/footage-silent.mp4`,
    videoUrl: `${base}/footage.mp4`,
  };
}
