import { type CosmosTrack } from "../remotion/types";

const TRACK_ENDPOINT = "https://www.fluncle.com/api/v1/tracks";

type ApiTrack = {
  trackId: string;
  title: string;
  artists: string[];
  album?: string;
  albumImageUrl?: string;

  artworkMaxUrl?: string;
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
    artworkUrl: found.artworkMaxUrl ?? found.albumImageUrl,
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
