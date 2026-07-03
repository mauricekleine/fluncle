// Local copy of the pure Media Transformations URL builders (RFC Unit 1 / Phase 0).
// The MT URL scheme is a found.fluncle.com CDN convention oRPC doesn't change;
// the consolidation into @fluncle/contracts is the Phase-1 cleanup. Keep this in
// step with apps/web/src/lib/media.ts.
import { type TrackListItem } from "@fluncle/contracts";
import { API_BASE, FOUND_BASE } from "@/config";

const MT = `${FOUND_BASE}/cdn-cgi/media`;

function master(logId: string, file: "footage.mp4" | "footage.social.mp4") {
  return `${FOUND_BASE}/${logId}/${file}`;
}

/**
 * A poster still (first frame) of the clean master, for first paint. The video
 * VINTAGE rides the source as its `?v` token (mirrors web media.ts videoVersion):
 * Media Transformations caches outputs in its own internal layer keyed on the
 * full URL, which the zone purge cannot evict — a re-render bumps videoSquaredAt,
 * so the URL changes and MT derives the fresh master.
 */
function videoPoster(logId: string, videoSquaredAt: string) {
  const epoch = Date.parse(videoSquaredAt);
  const version = Number.isNaN(epoch) ? 1 : epoch;
  return `${MT}/mode=frame,time=0s,format=jpg/${master(logId, "footage.mp4")}?v=${version}`;
}

/** The raw clean master (onError fallback target — MT can cold-fail / >100MB). */
function videoMaster(logId: string) {
  return master(logId, "footage.mp4");
}

/** The 30s preview proxy (live relay; expiring previewUrl tokens aren't used directly). */
function previewProxy(idOrLogId: string) {
  return `${API_BASE}/api/v1/preview/${idOrLogId}`;
}

/**
 * The per-card media ladder (RFC §0):
 * - clean square master present → square master, view-cropped to portrait (rung a)
 * - else → the cover card under preview audio                              (rung b)
 * - cover with no preview → a beautiful silent cover                       (rung c)
 * Legacy findings (videoUrl set but videoSquaredAt absent) deliberately take the
 * cover rung, NOT the baked-text portrait, so the native overlay never double-prints.
 *
 * NATIVE PLAYBACK NOTE (verified 2026-06-21): iOS AVPlayer requires HTTP Range
 * (it probes a 2-byte range first). Cloudflare Media Transformations video URLs
 * (videoCrop / videoRendition) return 200 with the FULL body — no range — so
 * AVPlayer fails with CoreMediaError -12939 "byte range length mismatch / server
 * not correctly configured". Only the RAW masters on found.fluncle.com honor range
 * (206). So the feed plays the raw square `footage.mp4` and crops to portrait via
 * VideoView `contentFit="cover"`. (Browsers tolerate the 200 MT crop — this is a
 * native-only constraint. Tradeoff: the square master is larger than a width
 * rendition; a range-capable portrait rendition is a Phase-1 backend follow-up.)
 */
export type CardMedia =
  | { kind: "video"; videoUrl: string; posterUrl: string; hasAudio: true }
  | { kind: "cover"; coverUrl: string | undefined; previewUrl: string | undefined };

export function resolveCardMedia(f: TrackListItem): CardMedia {
  const id = f.logId ?? f.trackId;
  if (f.logId && f.videoSquaredAt) {
    return {
      hasAudio: true,
      kind: "video",
      posterUrl: videoPoster(f.logId, f.videoSquaredAt),
      videoUrl: videoMaster(f.logId),
    };
  }
  return {
    coverUrl: f.albumImageUrl,
    kind: "cover",
    previewUrl: f.previewUrl ? previewProxy(id) : undefined,
  };
}
