import { type RadioNowPlaying } from "@fluncle/contracts";
import { type TrackListItem, type TrackListPage } from "./server/tracks";
import { type FeedItem } from "./mixtapes";

// Client reads use the public /api/tracks contract produced by lib/server/tracks.ts.
export type Track = TrackListItem;

export type { RadioNowPlaying };

export type TracksResponse = Omit<TrackListPage, "tracks"> & { tracks: FeedItem[] };

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

/**
 * One random RADIO-ELIGIBLE finding (a squared master + an observation) for the
 * cycling station. Served by the `get_random_radio_track` oRPC op under the
 * versioned prefix; the page builds the per-orientation silent video URLs from
 * the returned `logId`.
 */
export async function fetchRandomRadioTrack(): Promise<Track> {
  const response = await fetch("/api/v1/radio/random");

  if (!response.ok) {
    throw new Error(`Failed to load radio track: ${response.status}`);
  }

  const data = (await response.json()) as RandomTrackResponse;

  return data.track;
}

type RadioNowPlayingResponse = {
  nowPlaying: RadioNowPlaying;
  ok: true;
};

/**
 * The server-authoritative now-playing slot on the shared broadcast loop (RFC
 * radio-broadcast.md Unit A). Served by the `get_radio_now_playing` oRPC op. The
 * page seeks to `offsetMs`, runs the same modulo math locally off `serverEpochMs`
 * between polls, and re-fetches when `scheduleVersion` changes. A 404 (empty
 * eligible set) throws — the page surfaces the quiet-sector state.
 */
export async function fetchRadioNowPlaying(): Promise<RadioNowPlaying> {
  const response = await fetch("/api/v1/radio/now-playing");

  if (!response.ok) {
    throw new Error(`Failed to load now-playing: ${response.status}`);
  }

  const data = (await response.json()) as RadioNowPlayingResponse;

  return data.nowPlaying;
}
