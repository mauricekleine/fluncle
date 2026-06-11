import { getDb } from "./db";
import { readEnvs } from "./env";

const spotifyAccountsBaseUrl = "https://accounts.spotify.com";
const spotifyApiBaseUrl = "https://api.spotify.com/v1";
const spotifyScopes = ["playlist-modify-public", "playlist-modify-private"];
// Admin web login asks for identity only — never the playlist-write scopes the
// publish flow uses. The login exchange reads /v1/me and discards the tokens.
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

export type TrackMetadata = {
  trackId: string;
  spotifyUrl: string;
  spotifyUri: string;
  title: string;
  artists: string[];
  album?: string;
  albumImageUrl?: string;
  durationMs: number;
  isrc?: string;
  popularity?: number;
  releaseDate?: string;
};

export type TrackSearchResult = {
  id: string;
  spotifyUrl: string;
  title: string;
  artists: string[];
  album?: string;
  artworkUrl?: string;
};

export async function buildSpotifyAuthUrl(state: string): Promise<string> {
  return buildAuthorizeUrl(state, spotifyScopes);
}

// The admin-login authorize URL: identity scopes, the SAME registered redirect
// URI as the publish flow (the shared callback branches on state.purpose).
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

/**
 * Exchange an admin-login auth code for the caller's Spotify identity and throw
 * the tokens away. This is the LOGIN path — it must never touch spotify_auth (the
 * publish refresh token lives there); it only proves who is at the browser.
 */
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
  const uriMatch = input.match(/^spotify:track:([A-Za-z0-9]{22})$/);

  if (uriMatch) {
    return uriMatch[1];
  }

  let url: URL;

  try {
    url = new URL(input);
  } catch {
    throw new ApiError("invalid_spotify_url", "Invalid Spotify URL", 400);
  }

  if (url.hostname !== "open.spotify.com") {
    throw new ApiError(
      "invalid_spotify_url",
      "Invalid Spotify URL: expected open.spotify.com",
      400,
    );
  }

  const [kind, trackId] = url.pathname.split("/").filter(Boolean);

  if (kind !== "track" || !trackId || !/^[A-Za-z0-9]{22}$/.test(trackId)) {
    throw new ApiError("invalid_spotify_url", "Invalid Spotify track URL", 400);
  }

  return trackId;
}

export function tryParseSpotifyTrackUrl(input: string): string | undefined {
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
    spotifyUri: data.uri,
    spotifyUrl: data.external_urls?.spotify ?? `https://open.spotify.com/track/${data.id}`,
    title: data.name,
    trackId: data.id,
  };
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
    id: track.id,
    spotifyUrl: track.external_urls?.spotify ?? `https://open.spotify.com/track/${track.id}`,
    title: track.name,
  }));
}

export async function addTrackToPlaylist(track: TrackMetadata): Promise<void> {
  const env = await readEnvs(["SPOTIFY_PLAYLIST_ID"]);
  const accessToken = await getSpotifyAccessToken();

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

function toSearchResult(track: TrackMetadata): TrackSearchResult {
  return {
    album: track.album,
    artists: track.artists,
    artworkUrl: track.albumImageUrl,
    id: track.trackId,
    spotifyUrl: track.spotifyUrl,
    title: track.title,
  };
}

async function getSpotifyAccessToken(): Promise<string> {
  const db = await getDb();
  const result = await db.execute({
    args: ["spotify"],
    sql: `select access_token, refresh_token, expires_at
      from spotify_auth
      where service = ?
      limit 1`,
  });
  const auth = result.rows[0] as unknown as SpotifyAuthRow | undefined;

  if (!auth) {
    throw new ApiError("spotify_not_authenticated", "Spotify is not authenticated", 400);
  }

  const expiresAt = new Date(auth.expires_at).getTime();
  const refreshWindowMs = 60_000;

  if (expiresAt - refreshWindowMs > Date.now()) {
    return auth.access_token;
  }

  const data = await requestToken({
    grant_type: "refresh_token",
    refresh_token: auth.refresh_token,
  });

  const refreshToken = data.refresh_token ?? auth.refresh_token;
  await upsertSpotifyAuth(data.access_token, refreshToken, data.expires_in, data.scope);

  return data.access_token;
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
    throw new Error(await readApiError(response, "Spotify token request failed"));
  }

  return (await response.json()) as SpotifyTokenResponse;
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

async function spotifyFetch(
  path: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);

  const response = await fetch(`${spotifyApiBaseUrl}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    throw new Error(await readApiError(response, "Spotify API request failed"));
  }

  return response;
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
