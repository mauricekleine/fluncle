// Local copy of the pure Media Transformations URL builders (RFC Unit 1 / Phase 0).
// The MT URL scheme is a found.fluncle.com CDN convention oRPC doesn't change;
// the consolidation into @fluncle/contracts is the Phase-1 cleanup. Keep this in
// step with apps/web/src/lib/media.ts.
import { type TrackListItem } from "@fluncle/contracts";
import { API_BASE, FOUND_BASE } from "@/config";

const MT = `${FOUND_BASE}/cdn-cgi/media`;

// The feed plays the CLEAN square master ONLY — never `footage.social.mp4`, the
// portrait cut with baked "Found …"/coordinate/title text (that cut is a web-Stories /
// YouTube / TikTok asset; the app draws its own overlay, so baked text would
// double-print). This helper hard-codes the clean master's filename so no call site —
// including any onError fallback — can reach the social cut: "never social" is a
// compile-time guarantee, not a convention. Under the two-master model (videoSquaredAt
// set) `footage.mp4` IS the clean 1920² square; if a feed video ever shows baked text,
// that finding's stored `footage.mp4` itself carries text (a stamped-but-not-truly-
// squared master, or a square re-render that skipped hideOverlay) — a per-finding DATA
// fix at the source, never a URL the app can correct.
function cleanMaster(logId: string) {
  return `${FOUND_BASE}/${logId}/footage.mp4`;
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
  return `${MT}/mode=frame,time=0s,format=jpg/${cleanMaster(logId)}?v=${version}`;
}

/** The raw clean master (onError fallback target — MT can cold-fail / >100MB). */
function videoMaster(logId: string) {
  return cleanMaster(logId);
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

/**
 * The cover-led artwork for the radio's now-playing card. Radio is audio-only on this
 * surface — the ONLY sound is the spoken observation (never the commercial track), so
 * the finding's album art is the hero rather than the video (which the web plays silent
 * under the same observation). Prefer the album cover; fall back to the clean square
 * master's poster frame when a finding has a render but the cover is somehow absent.
 * Both are found.fluncle.com/CDN reads — no full-length audio ever streams here.
 */
export function radioArtworkUrl(f: TrackListItem): string | undefined {
  if (f.albumImageUrl) {
    return f.albumImageUrl;
  }

  return f.logId && f.videoSquaredAt ? videoPoster(f.logId, f.videoSquaredAt) : undefined;
}

/** The mixtape cover renditions the on-the-fly cover endpoint serves (mirrors apps/web/src/lib/mixtapes.ts). */
export type MixtapeCoverSize = "card" | "og" | "square" | "thumb" | "wide";

/**
 * The cover URL for a published mixtape, rendered on the fly by the web cover endpoint
 * (Satori over the baked Deep-Field background). Keep the `?v=` version in step with
 * apps/web/src/lib/mixtapes.ts `COVER_VERSION` so a re-bake busts both surfaces' caches.
 */
export function mixtapeCoverUrl(logId: string, size: MixtapeCoverSize = "square"): string {
  return `${API_BASE}/api/mixtape-cover/${encodeURIComponent(logId)}?size=${size}&v=2`;
}
