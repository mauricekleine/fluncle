export type Track = {
  addedAt: string;
  album?: string;
  albumImageUrl?: string;
  artists: string[];
  note?: string;
  spotifyUrl: string;
  title: string;
  trackId: string;
};

export type TracksResponse = {
  nextCursor?: string;
  totalCount: number;
  tracks: Track[];
};

export type RandomTrackResponse = {
  ok: true;
  track: Track;
};

export async function fetchTracks({
  cursor,
  limit,
}: {
  cursor?: string;
  limit: number;
}): Promise<TracksResponse> {
  const params = new URLSearchParams({ limit: String(limit) });

  if (cursor) {
    params.set("cursor", cursor);
  }

  const response = await fetch(`/api/tracks?${params.toString()}`);

  if (!response.ok) {
    throw new Error(`Failed to load tracks: ${response.status}`);
  }

  return (await response.json()) as TracksResponse;
}

export async function fetchRandomTrack(): Promise<Track> {
  const response = await fetch("/api/tracks/random");

  if (!response.ok) {
    throw new Error(`Failed to load random track: ${response.status}`);
  }

  const data = (await response.json()) as RandomTrackResponse;

  return data.track;
}
