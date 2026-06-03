import { db } from "./db/client";
import { loadEnv } from "./env";
import { CliError } from "./output";

const SPOTIFY_ACCOUNTS_BASE_URL = "https://accounts.spotify.com";
const SPOTIFY_API_BASE_URL = "https://api.spotify.com/v1";
const SPOTIFY_SCOPES = ["playlist-modify-public", "playlist-modify-private"];

type SpotifyTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
};

type SpotifyTrackResponse = {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  album?: {
    name?: string;
  };
  artists: Array<{
    name: string;
  }>;
  external_urls?: {
    spotify?: string;
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
  durationMs: number;
};

export function parseSpotifyTrackUrl(input: string): string {
  const uriMatch = input.match(/^spotify:track:([A-Za-z0-9]{22})$/);

  if (uriMatch) {
    return uriMatch[1];
  }

  let url: URL;

  try {
    url = new URL(input);
  } catch {
    throw new CliError("invalid_spotify_url", "Invalid Spotify URL");
  }

  if (url.hostname !== "open.spotify.com") {
    throw new CliError("invalid_spotify_url", "Invalid Spotify URL: expected open.spotify.com");
  }

  const [kind, trackId] = url.pathname.split("/").filter(Boolean);

  if (kind !== "track" || !trackId || !/^[A-Za-z0-9]{22}$/.test(trackId)) {
    throw new CliError("invalid_spotify_url", "Invalid Spotify track URL");
  }

  return trackId;
}

export function buildSpotifyAuthUrl(): string {
  const env = loadEnv(["SPOTIFY_CLIENT_ID", "SPOTIFY_REDIRECT_URI"]);
  const params = new URLSearchParams({
    client_id: env.SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: env.SPOTIFY_REDIRECT_URI,
    scope: SPOTIFY_SCOPES.join(" "),
  });

  return `${SPOTIFY_ACCOUNTS_BASE_URL}/authorize?${params.toString()}`;
}

export function extractCodeFromCallbackUrl(input: string): string {
  const url = new URL(input);
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");

  if (error) {
    throw new Error(`Spotify authorization failed: ${error}`);
  }

  if (!code) {
    throw new Error("Callback URL did not include a code");
  }

  return code;
}

export async function exchangeCodeForToken(code: string): Promise<void> {
  const env = loadEnv(["SPOTIFY_REDIRECT_URI"]);
  const data = await requestToken({
    grant_type: "authorization_code",
    code,
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
    trackId: data.id,
    spotifyUrl: data.external_urls?.spotify ?? `https://open.spotify.com/track/${data.id}`,
    spotifyUri: data.uri,
    title: data.name,
    artists: data.artists.map((artist) => artist.name),
    album: data.album?.name,
    durationMs: data.duration_ms,
  };
}

export async function addTrackToPlaylist(track: TrackMetadata): Promise<void> {
  const env = loadEnv(["SPOTIFY_PLAYLIST_ID"]);
  const accessToken = await getSpotifyAccessToken();

  await spotifyFetch(`/playlists/${env.SPOTIFY_PLAYLIST_ID}/items`, accessToken, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      uris: [track.spotifyUri],
    }),
  });
}

async function getSpotifyAccessToken(): Promise<string> {
  const result = await db.execute({
    sql: `select access_token, refresh_token, expires_at
      from spotify_auth
      where service = ?
      limit 1`,
    args: ["spotify"],
  });
  const auth = result.rows[0] as unknown as SpotifyAuthRow | undefined;

  if (!auth) {
    throw new Error("Spotify is not authenticated. Run: fluncle auth spotify");
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
  const env = loadEnv(["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"]);
  const response = await fetch(`${SPOTIFY_ACCOUNTS_BASE_URL}/api/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
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
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresIn * 1000);

  await db.execute({
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
    args: [
      "spotify",
      accessToken,
      refreshToken,
      expiresAt.toISOString(),
      scope,
      now.toISOString(),
    ],
  });
}

async function spotifyFetch(
  path: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(`${SPOTIFY_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
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
