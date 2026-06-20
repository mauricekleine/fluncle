// The one and only network call Fluncle Lens makes: a public read of a single
// finding by its Log ID, after the coordinate has already been detected locally.
// Nothing about the page is sent — only the bare Log ID goes out, in the URL path.

import { apiUrl, webUrl } from "./coordinate";
import { type FindingMeta } from "./types";

// A slow or hung metadata read shouldn't leave the hover card stuck on "Recovering"
// forever — bound it so the card resolves to the error state (the link still works).
const FETCH_TIMEOUT_MS = 8000;

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

// The slice of the public API's mixtape shape the lens reads. The full DTO is
// `MixtapeDTO` in `@fluncle/contracts`. A mixtape has no Spotify link and no
// release/album metadata; it carries a member count ("N bangers") and its own
// recorded/found dates. Its web page is the same `/log/<id>` route (derived here —
// the DTO has no `logPageUrl`).
type ApiMixtape = {
  /** ISO date Fluncle logged the mixtape. */
  addedAt?: string;
  artists?: string[];
  coverImageUrl?: string;
  logId?: string;
  /** How many bangers ride in the set. */
  memberCount?: number;
  /** ISO date the set was recorded. */
  recordedAt?: string;
  title?: string;
};

type ApiResponse = { mixtape?: ApiMixtape; ok?: boolean; track?: ApiTrack };

/** Year is the leading 4 digits of an ISO/loose release date, when present. */
function yearOf(releaseDate: string | undefined): string | undefined {
  if (!releaseDate) {
    return undefined;
  }

  const match = releaseDate.match(/^(\d{4})/);

  return match ? match[1] : undefined;
}

/**
 * A mixtape's canonical title carries a " | <coordinate>" suffix (the Log ID is
 * shown right beside it on every surface). Strip it for display — mirrors the web
 * app's `mixtapeDisplayTitle`. A custom title with no " | " passes through.
 */
function mixtapeDisplayTitle(title: string | undefined): string | undefined {
  return title?.split(" | ")[0];
}

/** Narrows the public track DTO to the fields the hover card and popup render. */
function trackToMeta(id: string, track: ApiTrack): FindingMeta {
  return {
    album: track.album,
    albumImageUrl: track.albumImageUrl,
    artists: track.artists,
    bpm: track.bpm,
    foundAt: track.addedAt,
    key: track.key,
    kind: "track",
    label: track.label,
    logId: track.logId ?? id,
    spotifyUrl: track.spotifyUrl,
    title: track.title,
    webUrl: track.logPageUrl ?? webUrl(id),
    year: yearOf(track.releaseDate),
  };
}

/** Narrows the public mixtape DTO to the fields the hover card and popup render. */
function mixtapeToMeta(id: string, mixtape: ApiMixtape): FindingMeta {
  return {
    albumImageUrl: mixtape.coverImageUrl,
    artists: mixtape.artists ?? ["Fluncle"],
    // Prefer the recorded date (when the set was played) over the logged date.
    foundAt: mixtape.recordedAt ?? mixtape.addedAt,
    kind: "mixtape",
    logId: mixtape.logId ?? id,
    memberCount: mixtape.memberCount,
    title: mixtapeDisplayTitle(mixtape.title),
    // A mixtape DTO has no logPageUrl; its log page is the same /log/<id> route.
    webUrl: webUrl(id),
  };
}

/**
 * Fetches a finding's metadata. A coordinate resolves to either a track
 * (`{ track }`) or one of Fluncle's mixtapes (`{ mixtape }`, the `F` middle slot).
 * Returns `null` on any failure (network, non-200, not-a-finding) so callers render
 * the "couldn't recover" state and lean on the link, which always works.
 */
export async function fetchFinding(id: string): Promise<FindingMeta | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(apiUrl(id), {
      credentials: "omit",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const body = (await response.json()) as ApiResponse;

    if (body.mixtape) {
      return mixtapeToMeta(id, body.mixtape);
    }

    if (body.track) {
      return trackToMeta(id, body.track);
    }

    return null;
  } catch {
    // Network error, abort (timeout), or malformed JSON — all collapse to the
    // error state.
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
