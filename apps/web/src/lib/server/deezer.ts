import { DEEZER_CANDIDATE_LIMIT } from "@fluncle/contracts/orpc";

import { logEvent } from "./log";
import { canonicalizeSearchTitle, matchKey } from "./track-match";

type DeezerTrack = {
  album?: { id?: number };

  duration?: number;
  error?: unknown;
  id?: number;
  preview?: string;
  title?: string;
};

type DeezerAlbum = {
  error?: unknown;
  label?: string;
};

export type DeezerEnrichment = {
  deezerTrackId?: string;
  label?: string;
  previewUrl?: string;
};

type DeezerSearchTrack = {
  artist?: { name?: string };
  duration?: number;
  id?: number;
  isrc?: string;
  title?: string;
};

type DeezerSearchResult = {
  data?: DeezerSearchTrack[];
  error?: unknown;
};

export type DeezerIsrcCandidate = {
  artistName: string;

  deezerTrackId?: string;
  durationMs: number;
  isrc: string;
  title: string;
};

const DEEZER_USER_AGENT = "Fluncle/1.0 (+https://www.fluncle.com)";

const DEEZER_TIMEOUT_MS = 10_000;

const DEEZER_SEARCH_LIMIT = DEEZER_CANDIDATE_LIMIT;

const DEEZER_QUOTA_ERROR_CODE = 4;

const DEEZER_DATA_EXCEPTION_CODE = 800;

const DEEZER_QUOTA_RETRY_DELAYS_MS = [1_200, 2_500];

export function deezerSearchQuery(artists: string[], title: string): string | undefined {
  const collapse = (text: string) => text.replaceAll('"', " ").replace(/\s+/g, " ").trim();
  const names = artists.map(collapse).filter((artist) => artist.length > 0);
  const canonical = collapse(canonicalizeSearchTitle(title));

  if (names.length === 0 || !canonical) {
    return undefined;
  }

  return [...names, canonical].join(" ");
}

type DeezerSearchAttempt =
  | { candidates: DeezerIsrcCandidate[]; outcome: "ok" }
  | { outcome: "quota" }
  | { outcome: "failed" };

export async function searchDeezerCandidates(
  input: {
    artists: string[];
    title: string;
  },
  retryDelaysMs: number[] = DEEZER_QUOTA_RETRY_DELAYS_MS,
): Promise<DeezerIsrcCandidate[]> {
  const query = deezerSearchQuery(input.artists, input.title);

  if (!query) {
    return [];
  }

  for (let attempt = 0; ; attempt += 1) {
    const result = await attemptDeezerSearch(query);

    if (result.outcome === "ok") {
      return result.candidates;
    }

    const delay = result.outcome === "quota" ? retryDelaysMs[attempt] : undefined;

    if (delay === undefined) {
      if (result.outcome === "quota") {
        logEvent("warn", "deezer.search-quota-exhausted", { attempts: attempt + 1, query });
      }

      return [];
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function attemptDeezerSearch(query: string): Promise<DeezerSearchAttempt> {
  let response: Response;

  try {
    response = await fetch(
      `https://api.deezer.com/search/track?q=${encodeURIComponent(query)}&limit=${DEEZER_SEARCH_LIMIT}`,
      {
        headers: { "User-Agent": DEEZER_USER_AGENT },
        signal: AbortSignal.timeout(DEEZER_TIMEOUT_MS),
      },
    );
  } catch (error) {
    logEvent("warn", "deezer.search-threw", { error });

    return { outcome: "failed" };
  }

  if (!response.ok) {
    logEvent("warn", "deezer.search-http-error", { status: response.status });

    return { outcome: "failed" };
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch (error) {
    logEvent("warn", "deezer.search-malformed-body", { error });

    return { outcome: "failed" };
  }

  const error = (body as DeezerSearchResult).error;

  if (error) {
    const code = (error as { code?: unknown }).code;

    if (code === DEEZER_QUOTA_ERROR_CODE) {
      return { outcome: "quota" };
    }

    logEvent("warn", "deezer.search-api-error", { error });

    return { outcome: "failed" };
  }

  const data = (body as DeezerSearchResult).data;

  if (!Array.isArray(data)) {
    logEvent("warn", "deezer.search-unexpected-shape", {});

    return { outcome: "failed" };
  }

  const candidates: DeezerIsrcCandidate[] = [];

  for (const hit of data) {
    const isrc = hit.isrc?.trim() ?? "";
    const hitTitle = hit.title?.trim() ?? "";
    const artistName = hit.artist?.name?.trim() ?? "";

    if (
      !isrc ||
      !hitTitle ||
      !artistName ||
      typeof hit.duration !== "number" ||
      hit.duration <= 0
    ) {
      continue;
    }

    candidates.push({
      artistName,

      ...(typeof hit.id === "number" ? { deezerTrackId: String(hit.id) } : {}),
      durationMs: Math.round(hit.duration * 1000),
      isrc,
      title: hitTitle,
    });
  }

  return { candidates, outcome: "ok" };
}

type DeezerTrackDetail = {
  error?: unknown;
  isrc?: string;
};

const DURATION_TOLERANCE_S = 4;

export async function lookupIsrcFromDeezer(input: {
  artists: string[];
  durationMs: number;
  title: string;
}): Promise<DeezerIsrcCandidate | undefined> {
  const query = deezerSearchQuery(input.artists, input.title);

  if (!query) {
    return undefined;
  }

  try {
    const searchResponse = await fetch(
      `https://api.deezer.com/search/track?q=${encodeURIComponent(query)}`,
    );

    if (!searchResponse.ok) {
      return undefined;
    }

    const search = (await searchResponse.json()) as DeezerSearchResult;

    if (search.error || !Array.isArray(search.data)) {
      return undefined;
    }

    const expectedSeconds = input.durationMs / 1000;
    const rowKey = matchKey(input.artists, input.title);
    const match = search.data.find(
      (candidate) =>
        typeof candidate.id === "number" &&
        typeof candidate.duration === "number" &&
        Math.abs(candidate.duration - expectedSeconds) <= DURATION_TOLERANCE_S &&
        matchKey([candidate.artist?.name ?? ""], candidate.title ?? "") === rowKey,
    );

    if (!match?.id) {
      return undefined;
    }

    const trackResponse = await fetch(`https://api.deezer.com/track/${match.id}`);

    if (!trackResponse.ok) {
      return undefined;
    }

    const detail = (await trackResponse.json()) as DeezerTrackDetail;

    if (detail.error || !detail.isrc?.trim()) {
      return undefined;
    }

    return {
      artistName: match.artist?.name?.trim() ?? "",
      deezerTrackId: String(match.id),
      durationMs: Math.round((match.duration ?? 0) * 1000),
      isrc: detail.isrc.trim(),
      title: match.title?.trim() ?? "",
    };
  } catch {
    return undefined;
  }
}

export async function enrichFromDeezer(
  isrc: string | null | undefined,
  expectedDurationMs?: number,
): Promise<DeezerEnrichment> {
  if (!isrc?.trim()) {
    return {};
  }

  try {
    const trackResponse = await fetch(
      `https://api.deezer.com/track/isrc:${encodeURIComponent(isrc.trim())}`,
    );

    if (!trackResponse.ok) {
      return {};
    }

    const track = (await trackResponse.json()) as DeezerTrack;

    if (track.error || !track.id) {
      return {};
    }

    const previewUrl = track.preview?.trim() ? track.preview : undefined;
    const durationConfirmed =
      typeof expectedDurationMs === "number" &&
      expectedDurationMs > 0 &&
      typeof track.duration === "number" &&
      Math.abs(track.duration - expectedDurationMs / 1000) <= DURATION_TOLERANCE_S;
    let label: string | undefined;

    if (track.album?.id) {
      const albumResponse = await fetch(`https://api.deezer.com/album/${track.album.id}`);

      if (albumResponse.ok) {
        const album = (await albumResponse.json()) as DeezerAlbum;

        if (!album.error && album.label?.trim()) {
          label = album.label.trim();
        }
      }
    }

    return { ...(durationConfirmed ? { deezerTrackId: String(track.id) } : {}), label, previewUrl };
  } catch {
    return {};
  }
}

export type DeezerIsrcLookup =
  | { deezerTrackId: string; outcome: "matched" }
  | { error: string; outcome: "failed" }
  | { outcome: "absent" }
  | { outcome: "quota" }
  | { outcome: "unvouchable" };

export async function lookupDeezerTrackByIsrc(
  isrc: string,
  expectedDurationMs: number,
): Promise<DeezerIsrcLookup> {
  const trimmed = isrc.trim();

  if (!trimmed || !(expectedDurationMs > 0)) {
    return { outcome: "unvouchable" };
  }

  let response: Response;

  try {
    response = await fetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(trimmed)}`, {
      headers: { "User-Agent": DEEZER_USER_AGENT },
      signal: AbortSignal.timeout(DEEZER_TIMEOUT_MS),
    });
  } catch (error) {
    logEvent("warn", "deezer.isrc-lookup-threw", { error });

    return { error: error instanceof Error ? error.message : String(error), outcome: "failed" };
  }

  if (!response.ok) {
    logEvent("warn", "deezer.isrc-lookup-http-error", { status: response.status });

    return { error: `Deezer answered HTTP ${response.status}`, outcome: "failed" };
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch (error) {
    logEvent("warn", "deezer.isrc-lookup-malformed-body", { error });

    return { error: "Deezer sent an unparseable body", outcome: "failed" };
  }

  const error = (body as DeezerTrack).error;

  if (error) {
    const code = (error as { code?: unknown }).code;

    if (code === DEEZER_QUOTA_ERROR_CODE) {
      return { outcome: "quota" };
    }

    if (code === DEEZER_DATA_EXCEPTION_CODE) {
      return { outcome: "absent" };
    }

    logEvent("warn", "deezer.isrc-lookup-api-error", { error });

    return { error: `Deezer error code ${String(code)}`, outcome: "failed" };
  }

  const track = body as DeezerTrack;

  if (typeof track.id !== "number") {
    logEvent("warn", "deezer.isrc-lookup-unexpected-shape", {});

    return { error: "Deezer sent no track id", outcome: "failed" };
  }

  const durationConfirmed =
    typeof track.duration === "number" &&
    track.duration > 0 &&
    Math.abs(track.duration - expectedDurationMs / 1000) <= DURATION_TOLERANCE_S;

  if (!durationConfirmed) {
    return { outcome: "unvouchable" };
  }

  return { deezerTrackId: String(track.id), outcome: "matched" };
}
