// Mirrors the client-relevant subset of the server's TrackListItem (see
// lib/server/tracks.ts) — /api/tracks already returns all of these. The media +
// enrichment fields (previewUrl, videoUrl, bpm, key, …) used to be dropped here,
// which is why the feed couldn't surface them and Stories had nothing to play.
export type Track = {
  addedAt: string;
  album?: string;
  albumImageUrl?: string;
  artists: string[];
  bpm?: number;
  durationMs?: number;
  enrichmentStatus?: string;
  isrc?: string;
  key?: string;
  label?: string;
  logId?: string;
  note?: string;
  previewUrl?: string;
  releaseDate?: string;
  spotifyUrl: string;
  tags?: string[];
  tiktokUrl?: string;
  title: string;
  trackId: string;
  videoUrl?: string;
  videoVehicle?: string;
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
