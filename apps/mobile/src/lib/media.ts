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

/** Portrait crop of the CLEAN square master. Valid only when videoSquaredAt is set. */
export function videoCrop(logId: string, orientation: "portrait" = "portrait") {
  const dims = orientation === "portrait" ? "width=1080,height=1920" : "width=1080,height=1080";
  return `${MT}/fit=crop,${dims}/${master(logId, "footage.mp4")}`;
}

/** A poster still (first frame) of the clean master, for first paint. */
export function videoPoster(logId: string) {
  return `${MT}/mode=frame,time=0s,format=jpg/${master(logId, "footage.mp4")}`;
}

/** A width-limited rendition for cellular. */
export function videoRendition(logId: string, width: 360 | 480 | 720 | 1080) {
  return `${MT}/mode=video,width=${width}/${master(logId, "footage.mp4")}`;
}

/** The raw clean master (onError fallback target — MT can cold-fail / >100MB). */
export function videoMaster(logId: string) {
  return master(logId, "footage.mp4");
}

/** The 30s preview proxy (live relay; expiring previewUrl tokens aren't used directly). */
export function previewProxy(idOrLogId: string) {
  return `${API_BASE}/api/v1/preview/${idOrLogId}`;
}

/**
 * The per-card media ladder (RFC §0):
 * - clean square master present → portrait crop + native overlay  (rung a)
 * - else → the cover card under preview audio                     (rung b)
 * - cover with no preview → a beautiful silent cover              (rung c)
 * Legacy findings (videoUrl set but videoSquaredAt absent) deliberately take the
 * cover rung, NOT the baked-text portrait, so the native overlay never double-prints.
 */
export type CardMedia =
  | { kind: "video"; videoUrl: string; posterUrl: string; rawUrl: string; hasAudio: true }
  | { kind: "cover"; coverUrl: string | undefined; previewUrl: string | undefined };

export function resolveCardMedia(f: TrackListItem): CardMedia {
  const id = f.logId ?? f.trackId;
  if (f.logId && f.videoSquaredAt) {
    return {
      hasAudio: true,
      kind: "video",
      posterUrl: videoPoster(f.logId),
      rawUrl: videoMaster(f.logId),
      videoUrl: videoCrop(f.logId, "portrait"),
    };
  }
  return {
    coverUrl: f.albumImageUrl,
    kind: "cover",
    previewUrl: f.previewUrl ? previewProxy(id) : undefined,
  };
}
