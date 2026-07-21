import { type RadioNowPlaying } from "@fluncle/contracts";
import { type TrackListItem, type TrackListPage } from "./server/tracks";
import { type FeedItem } from "./mixtapes";

// Client reads use the public /api/v1/findings feed contract produced by lib/server/tracks.ts.
export type Track = TrackListItem;

export type { RadioNowPlaying };

export type TracksResponse = Omit<TrackListPage, "tracks"> & { tracks: FeedItem[] };

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

type RandomTrackResponse = { ok: true; track: TrackListItem };

/**
 * One certified finding, picked at random by the server (`get_random_track`). The
 * 404 page's "throw you somewhere real" action: fetch a fresh coordinate on every
 * click, then navigate to its `/log/<logId>`. Returns undefined when the archive is
 * empty (the endpoint 404s) or the picked finding has no coordinate yet, so the
 * caller can fall back to the archive index rather than a dead link.
 */
export async function fetchRandomFindingLogId(): Promise<string | undefined> {
  const response = await fetch("/api/v1/tracks/random");

  if (!response.ok) {
    return undefined;
  }

  const data = (await response.json()) as RandomTrackResponse;

  return data.track.logId || undefined;
}

type RadioNowPlayingResponse = {
  nowPlaying: RadioNowPlaying;
  ok: true;
};

/**
 * The server-authoritative now-playing slot on the shared broadcast loop (the
 * radio-broadcast RFC, Unit A). Served by the `get_radio_now_playing` oRPC op. The
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
