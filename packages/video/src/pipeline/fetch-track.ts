// Fetch a single track's public metadata from the Fluncle API and map it onto
// the CosmosTrack shape used by the "NostalgicCosmos" composition.

import { type CosmosTrack } from "../remotion/types";

const TRACKS_ENDPOINT = "https://www.fluncle.com/api/tracks?limit=48";

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
 * Fetch a track by id from the public track list and map it onto CosmosTrack.
 * Throws clearly if the track is not present in the discovery window.
 */
export async function fetchTrack(trackId: string): Promise<CosmosTrack> {
  const res = await fetch(TRACKS_ENDPOINT, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(
      `fetchTrack: GET ${TRACKS_ENDPOINT} failed with ${res.status} ${res.statusText}`,
    );
  }

  const payload = (await res.json()) as ApiTrack[] | { tracks?: ApiTrack[]; data?: ApiTrack[] };
  const list: ApiTrack[] = Array.isArray(payload)
    ? payload
    : (payload.tracks ?? payload.data ?? []);

  const found = list.find((t) => t.trackId === trackId);
  if (!found) {
    throw new Error(
      `fetchTrack: trackId "${trackId}" not found in ${TRACKS_ENDPOINT} (${list.length} tracks in window)`,
    );
  }

  const track: CosmosTrack = {
    album: found.album,
    artists: found.artists ?? [],
    artworkUrl: found.albumImageUrl,
    discoveredAt: found.addedAt,
    durationMs: found.durationMs,
    features: found.features,
    label: found.label,
    logId: found.logId,
    note: found.note,
    releaseDate: found.releaseDate,
    title: found.title,
    trackId: found.trackId,
  };
  return track;
}
