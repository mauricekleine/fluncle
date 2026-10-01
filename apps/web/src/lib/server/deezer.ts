import { DEEZER_CANDIDATE_LIMIT } from "@fluncle/contracts/orpc";

import { logEvent } from "./log";
import { ApiError } from "./spotify";
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

export const DEEZER_USER_AGENT = "Fluncle/1.0 (+https://www.fluncle.com)";

const DEEZER_TIMEOUT_MS = 10_000;
const DEEZER_SUBMISSION_SEARCH_TIMEOUT_MS = 2_500;

const DEEZER_SEARCH_LIMIT = DEEZER_CANDIDATE_LIMIT;

export const DEEZER_QUOTA_ERROR_CODE = 4;

export const DEEZER_DATA_EXCEPTION_CODE = 800;

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
  artist?: { name?: string };
  duration?: number;
  error?: unknown;
  id?: number;
  isrc?: string;
  title?: string;
};

export type DeezerSubmissionCandidate = {
  album?: string;
  artists: string[];
  artworkUrl?: string;
  durationMs?: number;
  externalUrl: string;
  id: string;
  isrc: string;
  provider: "deezer";
  spotifyUrl: string;
  title: string;
};

export async function searchDeezerSubmissionTracks(
  query: string,
  limit: number,
): Promise<DeezerSubmissionCandidate[]> {
  let response: Response;

  try {
    response = await fetch(
      `https://api.deezer.com/search/track?q=${encodeURIComponent(query)}&limit=${limit}`,
      {
        headers: { "User-Agent": DEEZER_USER_AGENT },
        signal: AbortSignal.timeout(DEEZER_SUBMISSION_SEARCH_TIMEOUT_MS),
      },
    );
  } catch (error) {
    logEvent("warn", "deezer.submit-search-threw", { error });
    return [];
  }

  if (!response.ok) {
    logEvent("warn", "deezer.submit-search-http-error", { status: response.status });
    return [];
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch (error) {
    logEvent("warn", "deezer.submit-search-malformed-body", { error });
    return [];
  }

  const parsed = body as {
    data?: Array<{
      album?: { cover_medium?: string; title?: string };
      artist?: { name?: string };
      duration?: number;
      id?: number;
      isrc?: string;
      link?: string;
      title?: string;
    }>;
    error?: unknown;
  };

  if (!parsed || typeof parsed !== "object") {
    logEvent("warn", "deezer.submit-search-unexpected-shape", {});
    return [];
  }

  if (parsed.error) {
    const code = (parsed.error as { code?: unknown }).code;

    logEvent(
      "warn",
      code === DEEZER_QUOTA_ERROR_CODE
        ? "deezer.search-quota-exhausted"
        : "deezer.submit-search-api-error",
      {
        error: parsed.error,
      },
    );
    return [];
  }

  if (!Array.isArray(parsed.data)) {
    logEvent("warn", "deezer.submit-search-unexpected-shape", {});
    return [];
  }

  return parsed.data.flatMap((track) => {
    if (!track || typeof track !== "object") {
      return [];
    }

    const artist = track.artist?.name?.trim();
    const title = track.title?.trim();

    if (
      !Number.isSafeInteger(track.id) ||
      (track.id ?? 0) <= 0 ||
      !artist ||
      !title ||
      !track.isrc?.trim() ||
      typeof track.duration !== "number" ||
      track.duration <= 0
    ) {
      return [];
    }

    const id = String(track.id);

    return [
      {
        album: track.album?.title?.trim() || undefined,
        artists: [artist],
        artworkUrl: track.album?.cover_medium?.trim() || undefined,
        durationMs: Math.round(track.duration * 1000),
        externalUrl: track.link?.trim() || `https://www.deezer.com/track/${id}`,
        id,
        isrc: track.isrc.trim(),
        provider: "deezer" as const,
        spotifyUrl: "",
        title,
      },
    ];
  });
}

export async function getDeezerSubmissionTrack(id: string): Promise<
  | {
      artists: string[];
      durationMs: number;
      isrc: string;
      title: string;
    }
  | undefined
> {
  if (!/^[1-9]\d*$/.test(id)) {
    return undefined;
  }

  let response: Response;

  try {
    response = await fetch(`https://api.deezer.com/track/${id}`, {
      headers: { "User-Agent": DEEZER_USER_AGENT },
      signal: AbortSignal.timeout(DEEZER_TIMEOUT_MS),
    });
  } catch (error) {
    logEvent("warn", "deezer.submit-track-threw", { error });
    throw new ApiError(
      "submission_unavailable",
      "I can't check Deezer right now. Try again later.",
      503,
    );
  }

  if (!response.ok) {
    logEvent("warn", "deezer.submit-track-http-error", { status: response.status });
    throw new ApiError(
      "submission_unavailable",
      "I can't check Deezer right now. Try again later.",
      503,
    );
  }

  let track: DeezerTrackDetail;

  try {
    track = (await response.json()) as DeezerTrackDetail;
  } catch (error) {
    logEvent("warn", "deezer.submit-track-malformed-body", { error });
    throw new ApiError(
      "submission_unavailable",
      "I can't check Deezer right now. Try again later.",
      503,
    );
  }

  if (!track || typeof track !== "object") {
    logEvent("warn", "deezer.submit-track-unexpected-shape", {});
    throw new ApiError(
      "submission_unavailable",
      "I can't check Deezer right now. Try again later.",
      503,
    );
  }

  if ((track.error as { code?: unknown } | undefined)?.code === DEEZER_QUOTA_ERROR_CODE) {
    logEvent("warn", "deezer.search-quota-exhausted", { trackId: id });
    throw new ApiError(
      "submission_unavailable",
      "I can't check Deezer right now. Try again later.",
      503,
    );
  }

  if (track.error) {
    logEvent("warn", "deezer.submit-track-api-error", { error: track.error });
    throw new ApiError(
      "submission_unavailable",
      "I can't check Deezer right now. Try again later.",
      503,
    );
  }

  if (
    track.id !== Number(id) ||
    !track.isrc?.trim() ||
    !track.title?.trim() ||
    !track.artist?.name?.trim() ||
    typeof track.duration !== "number" ||
    track.duration <= 0
  ) {
    return undefined;
  }

  return {
    artists: [track.artist.name.trim()],
    durationMs: Math.round(track.duration * 1000),
    isrc: track.isrc.trim(),
    title: track.title.trim(),
  };
}

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
