import { publicApiGet } from "../api";

export type RecentTrack = {
  trackId: string;
  logId?: string;
  spotifyUrl: string;
  title: string;
  artists: string[];
  album?: string;
  albumImageUrl?: string;
  note?: string;
  addedAt: string;
  durationMs?: number;
  label?: string;
  isrc?: string;
  popularity?: number;
  previewUrl?: string;
  bpm?: number;
  key?: string;
  releaseDate?: string;
  enrichmentStatus?: string;
  videoModel?: string;
  videoModelReasoning?: string;
  videoUrl?: string;
  videoVehicle?: string;
  addedToSpotify: boolean;
  postedToTelegram: boolean;
};

export type ApiRecentTrack = Omit<RecentTrack, "addedToSpotify" | "postedToTelegram"> & {
  addedToSpotify?: boolean;
  postedToTelegram?: boolean;
};

export type TracksResponse = {
  tracks: ApiRecentTrack[];
  totalCount: number;
  nextCursor?: string;
};

// /api/tracks caps a single page at 48. `recent` only ever wants the newest few,
// but an explicit `--limit` above the page cap pages through with the cursor so
// the requested count is honoured rather than silently clipped at one page.
const pageSize = 48;

export function mapTrack(track: ApiRecentTrack): RecentTrack {
  return {
    addedAt: track.addedAt,
    addedToSpotify: track.addedToSpotify ?? true,
    album: track.album,
    albumImageUrl: track.albumImageUrl,
    artists: track.artists,
    bpm: track.bpm,
    durationMs: track.durationMs,
    enrichmentStatus: track.enrichmentStatus,
    isrc: track.isrc,
    key: track.key,
    label: track.label,
    logId: track.logId,
    note: track.note,
    popularity: track.popularity,
    postedToTelegram: track.postedToTelegram ?? true,
    previewUrl: track.previewUrl,
    releaseDate: track.releaseDate,
    spotifyUrl: track.spotifyUrl,
    title: track.title,
    trackId: track.trackId,
    videoModel: track.videoModel,
    videoModelReasoning: track.videoModelReasoning,
    videoUrl: track.videoUrl,
    videoVehicle: track.videoVehicle,
  };
}

// The latest findings, newest first. Pages through with the cursor only when
// `limit` exceeds one API page; the common small `limit` is a single request.
export async function recentCommand(limit: number): Promise<RecentTrack[]> {
  const results: RecentTrack[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({ limit: String(pageSize) });

    if (cursor) {
      params.set("cursor", cursor);
    }

    const response = await publicApiGet<TracksResponse>(`/api/tracks?${params.toString()}`);

    for (const apiTrack of response.tracks) {
      results.push(mapTrack(apiTrack));

      if (results.length >= limit) {
        return results;
      }
    }

    cursor = response.nextCursor;
  } while (cursor);

  return results;
}
