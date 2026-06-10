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
  tags?: string[];
  bpm?: number;
  key?: string;
  releaseDate?: string;
  enrichmentStatus?: string;
  tagsSource?: string;
  videoUrl?: string;
  videoVehicle?: string;
  addedToSpotify: boolean;
  postedToTelegram: boolean;
};

type TracksResponse = {
  tracks: Array<{
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
    tags?: string[];
    bpm?: number;
    key?: string;
    releaseDate?: string;
    enrichmentStatus?: string;
    tagsSource?: string;
    videoUrl?: string;
    videoVehicle?: string;
    addedToSpotify?: boolean;
    postedToTelegram?: boolean;
  }>;
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
      tags: track.tags,
      tagsSource: track.tagsSource,
      title: track.title,
      trackId: track.trackId,
      videoUrl: track.videoUrl,
      videoVehicle: track.videoVehicle,
    };
  });
}
