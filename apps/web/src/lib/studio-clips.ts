import { type ClipDTO } from "@fluncle/contracts/orpc";
import { trackMedia, videoAudioStripped, videoCrop, videoCropPoster } from "@/lib/media";

export type ClipStatusFilter = "all" | "done" | "pending";

export type ClipLibraryFilter = {
  recordingId: string;
  status: ClipStatusFilter;
};

export const ALL_FILTER = "all";

export const DEFAULT_CLIP_FILTER: ClipLibraryFilter = {
  recordingId: ALL_FILTER,
  status: ALL_FILTER,
};

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

export function sortClipsNewestFirst<T extends Pick<ClipDTO, "createdAt">>(clips: T[]): T[] {
  return [...clips].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function clipDurationMs(clip: Pick<ClipDTO, "inMs" | "outMs">): number {
  return Math.max(0, clip.outMs - clip.inMs);
}

export function clipPosterUrl(clipId: string, width = 480, version?: number): string {
  return videoCropPoster(clipId, "portrait", width, 0, version);
}

export function clipPreviewUrl(clipId: string, width = 720, version?: number): string {
  return videoCrop(clipId, "portrait", width, false, version);
}

export type ClipDownloadUrls = {
  silent: string;

  withAudio: string;
};

export function clipDownloadUrls(clipId: string, version?: number): ClipDownloadUrls {
  const withAudio = trackMedia(clipId).videoUrl;

  return { silent: videoAudioStripped(withAudio, version), withAudio };
}

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
