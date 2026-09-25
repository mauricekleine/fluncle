import { type TrackListItem } from "@fluncle/contracts";
import { buildMixtapeCoverUrl, type MixtapeCoverSize } from "@fluncle/contracts/util/mixtape-cover";
import { API_BASE, FOUND_BASE } from "@/config";

export { type MixtapeCoverSize } from "@fluncle/contracts/util/mixtape-cover";

const MT = `${FOUND_BASE}/cdn-cgi/media`;

function cleanMaster(logId: string) {
  return `${FOUND_BASE}/${logId}/footage.mp4`;
}

function videoPoster(logId: string, videoSquaredAt: string) {
  const epoch = Date.parse(videoSquaredAt);
  const version = Number.isNaN(epoch) ? 1 : epoch;
  return `${MT}/mode=frame,time=0s,format=jpg/${cleanMaster(logId)}?v=${version}`;
}

function videoMaster(logId: string) {
  return cleanMaster(logId);
}

function previewProxy(idOrLogId: string) {
  return `${API_BASE}/api/v1/preview/${idOrLogId}`;
}

export type CardMedia =
  | {
      kind: "video";
      videoUrl: string;
      posterUrl: string;

      hasAudio: false;
      previewUrl: string | undefined;
    }
  | { kind: "cover"; coverUrl: string | undefined; previewUrl: string | undefined };

export function hasRender(
  f: TrackListItem,
): f is TrackListItem & { logId: string; videoSquaredAt: string } {
  return Boolean(f.logId && f.videoSquaredAt);
}

export function resolveCardMedia(f: TrackListItem): CardMedia {
  const id = f.logId ?? f.trackId;

  const previewUrl =
    f.title.trim().length > 0 && f.artists.length > 0 ? previewProxy(id) : undefined;
  if (hasRender(f)) {
    return {
      hasAudio: false,
      kind: "video",
      posterUrl: videoPoster(f.logId, f.videoSquaredAt),
      previewUrl,
      videoUrl: videoMaster(f.logId),
    };
  }
  return {
    coverUrl: f.albumImageUrl,
    kind: "cover",
    previewUrl,
  };
}

export function radioArtworkUrl(f: TrackListItem): string | undefined {
  if (f.albumImageUrl) {
    return f.albumImageUrl;
  }

  return f.logId && f.videoSquaredAt ? videoPoster(f.logId, f.videoSquaredAt) : undefined;
}

export function mixtapeCoverUrl(logId: string, size: MixtapeCoverSize = "square"): string {
  return buildMixtapeCoverUrl(API_BASE, logId, size);
}
