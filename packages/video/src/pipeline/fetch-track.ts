// Fetch a single track's public metadata from the Fluncle API and map it onto
// the CosmosTrack shape used by the "NostalgicCosmos" composition.

import { type CosmosTrack } from "../remotion/types";

const TRACK_ENDPOINT = "https://www.fluncle.com/api/tracks";

type ApiTrack = {
  trackId: string;
  title: string;
  artists: string[];
  album?: string;
  albumImageUrl?: string;
  note?: string;
  addedAt: string;
  spotifyUrl?: string;
  logId?: string;
  durationMs?: number;
  label?: string;
  releaseDate?: string;
  isrc?: string;
  popularity?: number;
  previewUrl?: string;
  features?: {
    centroidHz?: number;
    highRatio?: number;
    midFlatness?: number;
    onsetRate?: number;
    subBassRatio?: number;
  };
};

/**
 * Fetch a track by its Spotify trackId OR its Log ID and map it onto CosmosTrack.
 * Uses the single-track endpoint, so it resolves any finding in the archive — not
 * just the recent discovery window — which is what lets the pipeline re-render an
 * older clip (pass its Log ID, e.g. "004.6.0K"). Throws clearly on 404.
 */
export async function fetchTrack(idOrLogId: string): Promise<CosmosTrack> {
  const url = `${TRACK_ENDPOINT}/${encodeURIComponent(idOrLogId)}`;
  const res = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (res.status === 404) {
    throw new Error(`fetchTrack: no track with id "${idOrLogId}" (GET ${url} -> 404)`);
  }
  if (!res.ok) {
    throw new Error(`fetchTrack: GET ${url} failed with ${res.status} ${res.statusText}`);
  }

  const payload = (await res.json()) as { ok?: boolean; track?: ApiTrack };
  const found = payload.track;
  if (!found) {
    throw new Error(`fetchTrack: response for "${idOrLogId}" contained no track`);
  }

  const track: CosmosTrack = {
    album: found.album,
    artists: found.artists ?? [],
    artworkUrl: found.albumImageUrl,
    discoveredAt: found.addedAt,
    durationMs: found.durationMs,
    features: found.features,
    isrc: found.isrc,
    label: found.label,
    logId: found.logId,
    note: found.note,
    releaseDate: found.releaseDate,
    title: found.title,
    trackId: found.trackId,
  };
  return track;
}
