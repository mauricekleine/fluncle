import {
  type RadioNowPlaying,
  type RadioNowPlayingResponse,
  type RandomTrackResponse,
  type TrackListItem,
  type TracksResponse,
} from "@fluncle/contracts";

export type Track = TrackListItem;

export type { RadioNowPlaying, TracksResponse };

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

  const response = await fetch(`/api/v1/findings?${params.toString()}`);

  if (!response.ok) {
    throw new Error(`Failed to load tracks: ${response.status}`);
  }

  return (await response.json()) as TracksResponse;
}

export async function fetchRandomFindingLogId(): Promise<string | undefined> {
  const response = await fetch("/api/v1/tracks/random");

  if (!response.ok) {
    return undefined;
  }

  const data = (await response.json()) as RandomTrackResponse;

  return data.track.logId || undefined;
}

export async function fetchRadioNowPlaying(): Promise<RadioNowPlaying> {
  const response = await fetch("/api/v1/radio/now-playing");

  if (!response.ok) {
    throw new Error(`Failed to load now-playing: ${response.status}`);
  }

  const data = (await response.json()) as RadioNowPlayingResponse;

  return data.nowPlaying;
}
