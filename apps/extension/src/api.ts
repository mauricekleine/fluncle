import { apiUrl, webUrl } from "./coordinate";
import { type FindingMeta } from "./types";

const FETCH_TIMEOUT_MS = 8000;

type ApiTrack = {
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

type ApiMixtape = {
  addedAt?: string;
  artists?: string[];
  coverImageUrl?: string;
  logId?: string;

  memberCount?: number;

  recordedAt?: string;
  title?: string;
};

type ApiResponse = { mixtape?: ApiMixtape; ok?: boolean; track?: ApiTrack };

function yearOf(releaseDate: string | undefined): string | undefined {
  if (!releaseDate) {
    return undefined;
  }

  const match = releaseDate.match(/^(\d{4})/);

  return match ? match[1] : undefined;
}

function mixtapeDisplayTitle(title: string | undefined): string | undefined {
  return title?.split(" | ")[0];
}

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

function mixtapeToMeta(id: string, mixtape: ApiMixtape): FindingMeta {
  return {
    albumImageUrl: mixtape.coverImageUrl,
    artists: mixtape.artists ?? ["Fluncle"],

    foundAt: mixtape.recordedAt ?? mixtape.addedAt,
    kind: "mixtape",
    logId: mixtape.logId ?? id,
    memberCount: mixtape.memberCount,
    title: mixtapeDisplayTitle(mixtape.title),

    webUrl: webUrl(id),
  };
}

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
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
