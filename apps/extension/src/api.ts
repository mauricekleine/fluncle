// The one and only network call Fluncle Lens makes: a public read of a single
// finding by its Log ID, after the coordinate has already been detected locally.
// Nothing about the page is sent — only the bare Log ID goes out, in the URL path.

import { apiUrl, webUrl } from "./coordinate";
import { type FindingMeta } from "./types";

// The slice of the public API's track shape the lens reads. The full DTO is
// `TrackListItem` in `@fluncle/contracts`; we keep a structural subset so the bundle
// stays dependency-free and tolerant of extra fields.
type ApiTrack = {
  /** ISO date Fluncle found it. */
  addedAt?: string;
  album?: string;
  albumImageUrl?: string;
  artists?: string[];
  bpm?: number;
  key?: string;
  label?: string;
  logId?: string;
  logPageUrl?: string;
  releaseDate?: string;
  spotifyUrl?: string;
  title?: string;
};

type ApiResponse = { ok?: boolean; track?: ApiTrack };

/** Year is the leading 4 digits of an ISO/loose release date, when present. */
function yearOf(releaseDate: string | undefined): string | undefined {
  if (!releaseDate) {
    return undefined;
  }

  const match = releaseDate.match(/^(\d{4})/);

  return match ? match[1] : undefined;
}

/** Narrows the public track DTO to the fields the hover card and popup render. */
function toMeta(id: string, track: ApiTrack): FindingMeta {
  return {
    album: track.album,
    albumImageUrl: track.albumImageUrl,
    artists: track.artists,
    bpm: track.bpm,
    foundAt: track.addedAt,
    key: track.key,
    label: track.label,
    logId: track.logId ?? id,
    spotifyUrl: track.spotifyUrl,
    title: track.title,
    webUrl: track.logPageUrl ?? webUrl(id),
    year: yearOf(track.releaseDate),
  };
}

/**
 * Fetches a finding's metadata. Returns `null` on any failure (network, non-200,
 * not-a-finding) so callers render the "couldn't recover" state and lean on the
 * link, which always works.
 */
export async function fetchFinding(id: string): Promise<FindingMeta | null> {
  try {
    const response = await fetch(apiUrl(id), {
      credentials: "omit",
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      return null;
    }

    const body = (await response.json()) as ApiResponse;

    if (!body.track) {
      return null;
    }

    return toMeta(id, body.track);
  } catch {
    return null;
  }
}
