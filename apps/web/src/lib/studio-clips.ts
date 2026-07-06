// The clip library's pure logic (Fluncle Studio). The cross-set library at
// `/admin/clips` browses every `mixtape_clips` row, so
// it needs two DOM-free things kept here for unit-testing (no React, no `<video>`):
//
//   1. The FILTER — narrow the loaded clip list by mixtape and/or status (the two
//      library dropdowns), client-side over the server-loaded set (the whole backlog
//      is small; filtering in the browser is instant and keeps the grid responsive
//      without a refetch per dropdown change).
//   2. The DOWNLOAD + POSTER URL builders — a clip is stored as its own pseudo-finding
//      `<clipId>/footage.mp4` (RFC §4), so the existing `trackMedia`/`videoCrop*`/
//      `videoAudioStripped` media helpers work UNCHANGED against the clipId. The
//      operator hand-posts (the irreducible in-app beat — IG/TikTok have no API music
//      path), so the card offers the file two ways: WITH audio (the bare master) for
//      Instagram, and the audio-STRIPPED variant for TikTok (the licensed sound is
//      attached in-app).

import { type ClipDTO } from "@fluncle/contracts/orpc";
import { trackMedia, videoAudioStripped, videoCrop, videoCropPoster } from "@/lib/media";

/** The library's status dropdown values: every clip, or one cut-queue state. */
export type ClipStatusFilter = "all" | "done" | "pending";

/**
 * The two-dropdown library filter. `recordingId` is "all" or a concrete RECORDING id
 * (the RFC recording-primitive is the clip's source; a legacy mixtape clip is normalised
 * onto its promoted recording's id upstream, so this one axis covers both).
 */
export type ClipLibraryFilter = {
  recordingId: string;
  status: ClipStatusFilter;
};

/** The "no narrowing" sentinel both dropdowns default to. */
export const ALL_FILTER = "all";

/** The default (unfiltered) library view. */
export const DEFAULT_CLIP_FILTER: ClipLibraryFilter = {
  recordingId: ALL_FILTER,
  status: ALL_FILTER,
};

/**
 * Narrow a clip list by recording and/or status. "all" on either axis is a no-op for
 * that axis, so the default filter returns the list untouched. Matches `clip.recordingId`
 * — the caller normalises a legacy mixtape clip onto its promoted recording's id before
 * filtering. Pure — the order of the input list is preserved (the server already sorts
 * newest-first).
 */
export function filterClips(clips: ClipDTO[], filter: ClipLibraryFilter): ClipDTO[] {
  return clips.filter((clip) => {
    if (filter.recordingId !== ALL_FILTER && clip.recordingId !== filter.recordingId) {
      return false;
    }

    if (filter.status !== ALL_FILTER && clip.status !== filter.status) {
      return false;
    }

    return true;
  });
}

/**
 * Sort clips newest-first by `createdAt` (descending). The clip library renders every clip
 * in ONE continuous grid ordered by when it was cut — newest at the top, no per-recording
 * grouping (each card still carries its own recording label). Pure — returns a new array,
 * leaving the input untouched. `createdAt` is an ISO-8601 UTC string, so a lexical compare
 * is chronological.
 */
export function sortClipsNewestFirst<T extends Pick<ClipDTO, "createdAt">>(clips: T[]): T[] {
  return [...clips].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** A clip's length in milliseconds (out − in), floored at 0 for a malformed window. */
export function clipDurationMs(clip: Pick<ClipDTO, "inMs" | "outMs">): number {
  return Math.max(0, clip.outMs - clip.inMs);
}

/**
 * The clip's 9:16 poster frame — the card thumbnail. A frame centre-cropped to
 * portrait off the clip's pseudo-finding `footage.mp4` (already a 1080×1920 cut, so
 * the cover crop just scales it down). `width` keeps the grid thumbnail light on the
 * wire instead of shipping the native 1080-wide poster.
 */
export function clipPosterUrl(clipId: string, width = 480, version?: number): string {
  return videoCropPoster(clipId, "portrait", width, 0, version);
}

/**
 * A light, edge-cached portrait rendition (WITH audio) for the card's inline preview
 * — a downscaled `videoCrop` off the clip's `footage.mp4`, not the bare master, so a
 * scrub stays cheap on a phone.
 */
export function clipPreviewUrl(clipId: string, width = 720, version?: number): string {
  return videoCrop(clipId, "portrait", width, false, version);
}

/** A clip's two download targets, both keyed off its pseudo-finding `footage.mp4`. */
export type ClipDownloadUrls = {
  /** Audio-STRIPPED (TikTok: the operator attaches the licensed sound in-app). */
  silent: string;
  /** The bare master, audio intact (Instagram). */
  withAudio: string;
};

/**
 * Build the with-audio + silent download URLs for a clip. With-audio is the bare R2
 * master (`<clipId>/footage.mp4`); silent runs that through the `audio=false` Media
 * Transformation. Distribution is deferred (the operator hand-posts), so these are
 * the v1 hand-off.
 */
export function clipDownloadUrls(clipId: string, version?: number): ClipDownloadUrls {
  const withAudio = trackMedia(clipId).videoUrl;

  return { silent: videoAudioStripped(withAudio, version), withAudio };
}

/**
 * The EXACT, finite set of public URLs the clip surfaces emit for one clip — the
 * inverse of the builders above, the clip twin of `videoPurgeUrls` (media.ts). When
 * the box RE-CUTS a clip it re-ships `<clipId>/footage.mp4` to the same R2 key, so the
 * bare master + every edge-cached Media-Transformation rendition derived from it stay
 * stale until their TTL expires; `finalize_clip_cut` purges this set so the next
 * request transcodes the fresh cut (#152 lesson). It mirrors the builders precisely:
 * the bare master (`clipDownloadUrls().withAudio`), the silent download
 * (`.silent`), and the library card's poster (`clipPosterUrl`) + inline preview
 * (`clipPreviewUrl`) — the only clip renditions any surface requests.
 *
 * NOTE on `videoPurgeUrls(clipId, { squared: true })`: it covers the bare master + the
 * portrait crops/poster, but its audio-stripped entry is off `footage.social.mp4`
 * (which a clip never has) — so it MISSES the clip's real silent download
 * (`audio=false` off `footage.mp4`). This precise set is why the cut path purges THIS,
 * not the squared finding set.
 */
export function clipPurgeUrls(clipId: string, version?: number): string[] {
  const { silent, withAudio } = clipDownloadUrls(clipId, version);

  return [
    ...new Set([
      withAudio,
      silent,
      clipPosterUrl(clipId, undefined, version),
      clipPreviewUrl(clipId, undefined, version),
    ]),
  ];
}
