import { publicApiGet } from "../api";

export type RecentTransmission = {
  trackId: string;
  spotifyUrl: string;
  title: string;
  artists: string[];
  album?: string;
  albumImageUrl?: string;
  note?: string;
  addedAt: string;
  addedToSpotify: boolean;
  postedToTelegram: boolean;
};

type TracksResponse = {
  tracks: Array<{
    trackId: string;
    spotifyUrl: string;
    title: string;
    artists: string[];
    album?: string;
    albumImageUrl?: string;
    note?: string;
    addedAt: string;
    addedToSpotify?: boolean;
    postedToTelegram?: boolean;
  }>;
  totalCount: number;
  nextCursor?: string;
};

export async function recentCommand(limit: number): Promise<RecentTransmission[]> {
  const response = await publicApiGet<TracksResponse>(`/api/tracks?limit=${limit}`);

  return response.tracks.map((track) => {
    return {
      addedAt: track.addedAt,
      addedToSpotify: track.addedToSpotify ?? true,
      album: track.album,
      albumImageUrl: track.albumImageUrl,
      artists: track.artists,
      note: track.note,
      postedToTelegram: track.postedToTelegram ?? true,
      spotifyUrl: track.spotifyUrl,
      title: track.title,
      trackId: track.trackId,
    };
  });
}
