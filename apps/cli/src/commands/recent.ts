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

type ApiRecentTrack = Omit<RecentTrack, "addedToSpotify" | "postedToTelegram"> & {
  addedToSpotify?: boolean;
  postedToTelegram?: boolean;
};

type TracksResponse = {
  tracks: ApiRecentTrack[];
  totalCount: number;
  nextCursor?: string;
};

export async function recentCommand(limit: number): Promise<RecentTrack[]> {
  const response = await publicApiGet<TracksResponse>(`/api/tracks?limit=${limit}`);

  return response.tracks.map((track) => {
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
  });
}
