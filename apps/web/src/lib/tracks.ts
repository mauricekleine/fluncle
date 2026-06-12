import { type TrackListItem, type TrackListPage } from "./server/tracks";

// Client reads use the public /api/tracks contract produced by lib/server/tracks.ts.
// tags is kept as optional compatibility slack for older UI/pipeline callers; the
// current API does not select a tags field.
export type Track = TrackListItem & { tags?: string[] };

export type TracksResponse = Omit<TrackListPage, "tracks"> & { tracks: Track[] };

type RandomTrackResponse = {
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
