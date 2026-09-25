import { type TrackSearchResult } from "@fluncle/contracts";

export type { TrackSearchResult };

import { parseSpotifyTrackId } from "../spotify-track-id";
import { getDb, typedRow } from "./db";
import { readEnvs } from "./env";
import { logEvent } from "./log";
import { recordSpotifyThrottle } from "./spotify-anchor-breaker";
import { isSpotifyCallBudgetAvailable, recordSpotifyCall } from "./spotify-budget";

const spotifyAccountsBaseUrl = "https://accounts.spotify.com";
const spotifyApiBaseUrl = "https://api.spotify.com/v1";

const spotifyScopes = ["playlist-modify-public", "playlist-modify-private", "ugc-image-upload"];

const spotifyLoginScopes = ["user-read-email"];

type SpotifyTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
};

type SpotifyImage = {
  height?: number;
  url: string;
  width?: number;
};

type SpotifyTrackResponse = {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  popularity?: number;
  album?: {
    images?: SpotifyImage[];
    name?: string;
    release_date?: string;
  };
  artists: Array<{
    id: string;
    name: string;
  }>;
  external_ids?: {
    isrc?: string;
  };
  external_urls?: {
    spotify?: string;
  };
};

type SpotifySearchResponse = {
  tracks?: {
    items?: SpotifyTrackResponse[];
  };
};

type SpotifyAuthRow = {
  access_token: string;
  refresh_token: string;
  expires_at: string;
};

export const SPOTIFY_REAUTH_REQUIRED = "spotify_reauth_required";

const spotifyTokenStaleDays = 150;

export type SpotifyAuthStatus = {
  connected: boolean;

  ageDays?: number;

  stale: boolean;
};

class SpotifyTokenError extends Error {
  spotifyError?: string;

  constructor(message: string, spotifyError?: string) {
    super(message);
    this.name = "SpotifyTokenError";
    this.spotifyError = spotifyError;
  }
}

export type TrackMetadata = {
  trackId: string;
  spotifyUrl: string;
  spotifyUri: string;
  title: string;
  artists: string[];

  spotifyArtistIds: string[];
  album?: string;
  albumImageUrl?: string;
  durationMs: number;
  isrc?: string;
  popularity?: number;
  releaseDate?: string;
};

export async function buildSpotifyAuthUrl(state: string): Promise<string> {
  return buildAuthorizeUrl(state, spotifyScopes);
}

export async function buildSpotifyLoginUrl(state: string): Promise<string> {
  return buildAuthorizeUrl(state, spotifyLoginScopes);
}

async function buildAuthorizeUrl(state: string, scopes: string[]): Promise<string> {
  const env = await readEnvs(["SPOTIFY_CLIENT_ID", "SPOTIFY_REDIRECT_URI"]);
  const params = new URLSearchParams({
    client_id: env.SPOTIFY_CLIENT_ID,
    redirect_uri: env.SPOTIFY_REDIRECT_URI,
    response_type: "code",
    scope: scopes.join(" "),
    state,
  });

  return `${spotifyAccountsBaseUrl}/authorize?${params.toString()}`;
}

export type SpotifyProfile = {
  displayName?: string;
  email?: string;
  id: string;
};

type SpotifyProfileResponse = {
  display_name?: string;
  email?: string;
  id: string;
};

export async function fetchSpotifyProfile(code: string): Promise<SpotifyProfile> {
  const env = await readEnvs(["SPOTIFY_REDIRECT_URI"]);
  const token = await requestToken({
    code,
    grant_type: "authorization_code",
    redirect_uri: env.SPOTIFY_REDIRECT_URI,
  });
  const response = await spotifyFetch("/me", token.access_token);
  const data = (await response.json()) as SpotifyProfileResponse;

  return {
    displayName: data.display_name,
    email: data.email,
    id: data.id,
  };
}

export function parseSpotifyTrackUrl(input: string): string {
  const parsed = parseSpotifyTrackId(input);

  if (parsed.ok) {
    return parsed.trackId;
  }

  switch (parsed.reason) {
    case "not_a_url":
      throw new ApiError("invalid_spotify_url", "Invalid Spotify URL", 400);
    case "wrong_host":
      throw new ApiError(
        "invalid_spotify_url",
        "Invalid Spotify URL: expected open.spotify.com",
        400,
      );
    case "not_a_track":
      throw new ApiError("invalid_spotify_url", "Invalid Spotify track URL", 400);
  }
}

function tryParseSpotifyTrackUrl(input: string): string | undefined {
  try {
    return parseSpotifyTrackUrl(input);
  } catch {
    return undefined;
  }
}

export async function exchangeCodeForToken(code: string): Promise<void> {
  const env = await readEnvs(["SPOTIFY_REDIRECT_URI"]);
  const data = await requestToken({
    code,
    grant_type: "authorization_code",
    redirect_uri: env.SPOTIFY_REDIRECT_URI,
  });

  if (!data.refresh_token) {
    throw new Error("Spotify did not return a refresh token");
  }

  await upsertSpotifyAuth(data.access_token, data.refresh_token, data.expires_in, data.scope);
}

export async function fetchTrackMetadata(trackId: string): Promise<TrackMetadata> {
  const accessToken = await getSpotifyAccessToken();
  const response = await spotifyFetch(`/tracks/${trackId}`, accessToken);
  const data = (await response.json()) as SpotifyTrackResponse;

  return {
    album: data.album?.name,
    albumImageUrl: selectAlbumImageUrl(data.album?.images),
    artists: data.artists.map((artist) => artist.name),
    durationMs: data.duration_ms,
    isrc: data.external_ids?.isrc,
    popularity: data.popularity,
    releaseDate: data.album?.release_date,
    spotifyArtistIds: data.artists.map((artist) => artist.id),
    spotifyUri: data.uri,
    spotifyUrl: data.external_urls?.spotify ?? `https://open.spotify.com/track/${data.id}`,
    title: data.name,
    trackId: data.id,
  };
}

type SpotifyArtistResponse = {
  id: string;
  images?: SpotifyImage[];
};

export type ArtistImagesFetchResult = {
  budgetLimited: boolean;
  checkedCount: number;
  checkedIds: string[];
  failures: Map<string, string>;
  images: Map<string, string>;
  missingIds: Set<string>;
  rateLimited: boolean;
};

export async function fetchArtistImages(
  spotifyArtistIds: string[],
): Promise<ArtistImagesFetchResult> {
  const ids = [...new Set(spotifyArtistIds.filter((id): id is string => Boolean(id)))];
  const result: ArtistImagesFetchResult = {
    budgetLimited: false,
    checkedCount: 0,
    checkedIds: [],
    failures: new Map(),
    images: new Map(),
    missingIds: new Set(),
    rateLimited: false,
  };

  if (ids.length === 0) {
    return result;
  }

  const accessToken = await getSpotifyAccessToken();

  for (const id of ids) {
    if (!(await isSpotifyCallBudgetAvailable())) {
      result.budgetLimited = true;
      break;
    }

    result.checkedIds.push(id);
    result.checkedCount += 1;

    try {
      const response = await spotifyFetch(`/artists/${encodeURIComponent(id)}`, accessToken);
      const artist = (await response.json()) as SpotifyArtistResponse | null;

      if (
        !artist ||
        artist.id !== id ||
        (artist.images !== undefined && !Array.isArray(artist.images))
      ) {
        result.failures.set(id, "Spotify artist response did not match the requested artist");
        continue;
      }

      const url = selectLargestImageUrl(artist.images);

      if (url) {
        result.images.set(id, url);
      } else {
        result.missingIds.add(id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes("429")) {
        result.rateLimited = true;
        logEvent("warn", "spotify.artist-image-rate-limited", { artistId: id, error });
        break;
      }

      result.failures.set(id, message);
      logEvent("warn", "spotify.artist-image-failed", { artistId: id, error });
    } finally {
      try {
        await recordSpotifyCall();
      } catch (error) {
        logEvent("warn", "spotify.call-meter-record-failed", {
          endpoint: "/artists/:id",
          error,
        });
      }
    }
  }

  return result;
}

export async function searchTrackCandidates(query: string): Promise<TrackSearchResult[]> {
  const trackId = tryParseSpotifyTrackUrl(query);

  if (trackId) {
    return [toSearchResult(await fetchTrackMetadata(trackId))];
  }

  const accessToken = await getSpotifyAccessToken();
  const params = new URLSearchParams({
    limit: "8",
    q: query,
    type: "track",
  });
  const response = await spotifyFetch(`/search?${params.toString()}`, accessToken);
  const data = (await response.json()) as SpotifySearchResponse;

  return (data.tracks?.items ?? []).map((track) => ({
    album: track.album?.name,
    artists: track.artists.map((artist) => artist.name),
    artworkUrl: selectAlbumImageUrl(track.album?.images),
    durationMs: track.duration_ms,
    id: track.id,

    spotifyArtistIds: track.artists.map((artist) => artist.id),
    spotifyUrl: track.external_urls?.spotify ?? `https://open.spotify.com/track/${track.id}`,
    title: track.name,
  }));
}

type SpotifyIsrcMatch = {
  albumImageUrl?: string;

  artists: Array<{ id: string; name: string }>;
  spotifyUri: string;
  spotifyUrl: string;
  trackId: string;
};

export type SpotifyIsrcLookup = {
  match?: SpotifyIsrcMatch;
  rateLimited: boolean;

  unauthorized?: boolean;
};

export async function findSpotifyTrackByIsrc(isrc: string): Promise<SpotifyIsrcLookup> {
  const clean = isrc.trim();

  if (!clean) {
    return { rateLimited: false };
  }

  try {
    const accessToken = await getSpotifyAccessToken();
    const params = new URLSearchParams({ limit: "1", q: `isrc:${clean}`, type: "track" });
    const response = await spotifyFetch(`/search?${params.toString()}`, accessToken);
    const data = (await response.json()) as SpotifySearchResponse;
    const track = data.tracks?.items?.[0];

    if (!track?.id) {
      return { rateLimited: false };
    }

    return {
      match: {
        albumImageUrl: selectAlbumImageUrl(track.album?.images),
        artists: track.artists.map((artist) => ({ id: artist.id, name: artist.name })),
        spotifyUri: `spotify:track:${track.id}`,
        spotifyUrl: track.external_urls?.spotify ?? `https://open.spotify.com/track/${track.id}`,
        trackId: track.id,
      },
      rateLimited: false,
    };
  } catch (error) {
    logEvent("warn", "spotify.isrc-lookup-failed", { error, isrc: clean });

    if (
      error instanceof ApiError &&
      (error.code === "spotify_not_authenticated" || error.code === SPOTIFY_REAUTH_REQUIRED)
    ) {
      return { rateLimited: false, unauthorized: true };
    }

    const rateLimited = error instanceof Error && error.message.includes("429");

    return { rateLimited };
  }
}

export async function fetchPlaylistFollowerCount(): Promise<number> {
  const [env, accessToken] = await Promise.all([
    readEnvs(["SPOTIFY_PLAYLIST_ID"]),
    getSpotifyAccessToken(),
  ]);
  const response = await spotifyFetch(
    `/playlists/${env.SPOTIFY_PLAYLIST_ID}?fields=followers.total`,
    accessToken,
  );
  const data = (await response.json()) as { followers?: { total?: number } };
  const total = data.followers?.total;

  if (typeof total !== "number" || !Number.isFinite(total)) {
    throw new Error("Spotify playlist response missing followers.total");
  }

  return total;
}

export async function addTrackToPlaylist(track: TrackMetadata): Promise<void> {
  const [env, accessToken] = await Promise.all([
    readEnvs(["SPOTIFY_PLAYLIST_ID"]),
    getSpotifyAccessToken(),
  ]);

  await spotifyFetch(`/playlists/${env.SPOTIFY_PLAYLIST_ID}/items`, accessToken, {
    body: JSON.stringify({
      uris: [track.spotifyUri],
    }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });
}

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 500) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

function selectAlbumImageUrl(images: SpotifyImage[] | undefined): string | undefined {
  if (!images?.length) {
    return undefined;
  }

  return (
    [...images]
      .sort((left, right) => (left.width ?? 0) - (right.width ?? 0))
      .find((image) => (image.width ?? 0) >= 300)?.url ?? images[0]?.url
  );
}

function selectLargestImageUrl(images: SpotifyImage[] | undefined): string | undefined {
  if (!images?.length) {
    return undefined;
  }

  return [...images]
    .filter(
      (image): image is SpotifyImage =>
        typeof image === "object" &&
        image !== null &&
        typeof image.url === "string" &&
        image.url.trim().length > 0,
    )
    .sort((left, right) => (right.width ?? 0) - (left.width ?? 0))[0]?.url;
}

function toSearchResult(track: TrackMetadata): TrackSearchResult {
  return {
    album: track.album,
    artists: track.artists,
    artworkUrl: track.albumImageUrl,
    durationMs: track.durationMs,
    id: track.trackId,
    spotifyArtistIds: track.spotifyArtistIds,
    spotifyUrl: track.spotifyUrl,
    title: track.title,
  };
}

async function readSpotifyAuthRow(): Promise<SpotifyAuthRow | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: ["spotify"],
    sql: `select access_token, refresh_token, expires_at
      from spotify_auth
      where service = ?
      limit 1`,
  });

  return typedRow<SpotifyAuthRow>(result.rows);
}

export async function getSpotifyAccessToken(): Promise<string> {
  const auth = await readSpotifyAuthRow();

  if (!auth) {
    throw new ApiError("spotify_not_authenticated", "Spotify is not authenticated", 400);
  }

  const expiresAt = new Date(auth.expires_at).getTime();
  const refreshWindowMs = 60_000;

  if (expiresAt - refreshWindowMs > Date.now()) {
    return auth.access_token;
  }

  let data: SpotifyTokenResponse;

  try {
    data = await requestToken({
      grant_type: "refresh_token",
      refresh_token: auth.refresh_token,
    });
  } catch (error) {
    if (error instanceof SpotifyTokenError && error.spotifyError === "invalid_grant") {
      const current = await readSpotifyAuthRow();

      if (current && current.refresh_token !== auth.refresh_token) {
        return current.access_token;
      }

      await clearSpotifyAuth();

      throw new ApiError(
        SPOTIFY_REAUTH_REQUIRED,
        "Spotify needs reconnecting — its saved authorization expired. Reconnect from the board.",
        401,
      );
    }

    throw error;
  }

  const refreshToken = data.refresh_token ?? auth.refresh_token;
  await upsertSpotifyAuth(data.access_token, refreshToken, data.expires_in, data.scope);

  return data.access_token;
}

export async function getSpotifyAuthStatus(): Promise<SpotifyAuthStatus> {
  const db = await getDb();
  const result = await db.execute({
    args: ["spotify"],
    sql: `select updated_at from spotify_auth where service = ? limit 1`,
  });
  const row = typedRow<{ updated_at: string }>(result.rows);

  if (!row) {
    return { connected: false, stale: false };
  }

  const ageDays = Math.floor((Date.now() - new Date(row.updated_at).getTime()) / 86_400_000);

  return {
    ageDays,
    connected: true,
    stale: ageDays >= spotifyTokenStaleDays,
  };
}

async function clearSpotifyAuth(): Promise<void> {
  const db = await getDb();

  await db.execute({
    args: ["spotify"],
    sql: `delete from spotify_auth where service = ?`,
  });
}

async function requestToken(params: Record<string, string>): Promise<SpotifyTokenResponse> {
  const env = await readEnvs(["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"]);
  const response = await fetch(`${spotifyAccountsBaseUrl}/api/token`, {
    body: new URLSearchParams(params),
    headers: {
      Authorization: `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });

  if (!response.ok) {
    const body = await response.text();
    const detail = body
      ? `${response.status} ${response.statusText} - ${body}`
      : `${response.status} ${response.statusText}`;

    throw new SpotifyTokenError(`Spotify token request failed: ${detail}`, parseTokenError(body));
  }

  return (await response.json()) as SpotifyTokenResponse;
}

function parseTokenError(body: string): string | undefined {
  if (!body) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(body) as { error?: unknown };

    return typeof parsed.error === "string" ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

async function upsertSpotifyAuth(
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
  scope: string,
): Promise<void> {
  const db = await getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresIn * 1000);

  await db.execute({
    args: ["spotify", accessToken, refreshToken, expiresAt.toISOString(), scope, now.toISOString()],
    sql: `insert into spotify_auth (
        service,
        access_token,
        refresh_token,
        expires_at,
        scope,
        updated_at
      ) values (?, ?, ?, ?, ?, ?)
      on conflict(service) do update set
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        scope = excluded.scope,
        updated_at = excluded.updated_at`,
  });
}

const SPOTIFY_MAX_RETRIES = 2;

const SPOTIFY_RETRY_BUDGET_MS = 10_000;

const SPOTIFY_DEFAULT_RETRY_MS = 1_000;

const SPOTIFY_IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT"]);

function parseRetryAfterMs(header: null | string): number {
  const seconds = Number((header ?? "").trim());

  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : SPOTIFY_DEFAULT_RETRY_MS;
}

export async function spotifyFetch(
  path: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);

  const method = (init.method ?? "GET").toUpperCase();
  const retryable = SPOTIFY_IDEMPOTENT_METHODS.has(method);
  let spentMs = 0;

  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${spotifyApiBaseUrl}${path}`, {
      ...init,
      headers,
    });

    if (response.ok) {
      return response;
    }

    if (response.status === 429) {
      const quotaExceeded = await Promise.resolve()
        .then(() => response.clone().text())
        .then((body) => body.includes("QUOTA_EXCEEDED"))
        .catch(() => false);
      await recordSpotifyThrottle(Date.now(), quotaExceeded);
    }

    if (response.status === 429 && retryable && attempt < SPOTIFY_MAX_RETRIES) {
      const waitMs = parseRetryAfterMs(response.headers.get("Retry-After"));

      if (spentMs + waitMs <= SPOTIFY_RETRY_BUDGET_MS) {
        spentMs += waitMs;

        logEvent("warn", "spotify.rate-limited-retry", {
          attempt: attempt + 1,
          endpoint: path.split("?")[0] ?? path,
          method,
          waitMs,
        });
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
    }

    throw new Error(await readApiError(response, "Spotify API request failed"));
  }
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  const body = await response.text();

  if (!body) {
    return `${fallback}: ${response.status} ${response.statusText}`;
  }

  if (response.status === 404) {
    return `${fallback}: ${response.status} ${response.statusText} - ${body}. Spotify track IDs are case-sensitive; copy the full URL from Spotify again.`;
  }

  return `${fallback}: ${response.status} ${response.statusText} - ${body}`;
}
