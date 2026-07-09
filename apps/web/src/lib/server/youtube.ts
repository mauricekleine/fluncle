// Our own YouTube OAuth + token machinery for mixtape video distribution. Mirrors
// the Spotify token path (spotify.ts): the durable refresh token lives in
// youtube_auth (server-side), and we mint a short-lived access token on demand —
// for the CLI's resumable upload PUT (the YouTube data PUT is NOT self-authorizing)
// and for the server-side unlisted→public flip (videos.update). Identity login is
// Spotify-only; YouTube is purely a distribution sink, so there's no login path.

import { getDb, typedRow } from "./db";
import { readEnvs } from "./env";
import { ApiError } from "./spotify";

const googleAuthBaseUrl = "https://accounts.google.com/o/oauth2/v2/auth";
const googleTokenUrl = "https://oauth2.googleapis.com/token";

// youtube.upload covers videos.insert (incl. privacyStatus=unlisted at insert) +
// thumbnails.set; youtube.force-ssl is added only for the unlisted→public flip
// (videos.update). access_type=offline + prompt=consent guarantee a refresh token.
const youtubeScopes = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.force-ssl",
];

type YouTubeTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
};

type YouTubeAuthRow = {
  access_token: string;
  refresh_token: string;
  expires_at: string;
};

export async function buildYouTubeAuthUrl(state: string): Promise<string> {
  const env = await readEnvs(["YOUTUBE_CLIENT_ID", "YOUTUBE_REDIRECT_URI"]);
  const params = new URLSearchParams({
    access_type: "offline",
    client_id: env.YOUTUBE_CLIENT_ID,
    // Force the consent screen so Google re-issues a refresh token even when the
    // operator has authorized before (it otherwise omits it on re-auth).
    prompt: "consent",
    redirect_uri: env.YOUTUBE_REDIRECT_URI,
    response_type: "code",
    scope: youtubeScopes.join(" "),
    state,
  });

  return `${googleAuthBaseUrl}?${params.toString()}`;
}

export async function exchangeCodeForYouTubeToken(code: string): Promise<void> {
  const env = await readEnvs(["YOUTUBE_REDIRECT_URI"]);
  const data = await requestToken({
    code,
    grant_type: "authorization_code",
    redirect_uri: env.YOUTUBE_REDIRECT_URI,
  });

  if (!data.refresh_token) {
    throw new Error("YouTube did not return a refresh token");
  }

  await upsertYouTubeAuth(data.access_token, data.refresh_token, data.expires_in, data.scope);
}

/**
 * A valid YouTube access token, refreshing via the stored refresh token when the
 * current one is within ~60s of expiry. Mirrors getSpotifyAccessToken.
 */
export async function getYouTubeAccessToken(): Promise<string> {
  const db = await getDb();
  const result = await db.execute({
    args: ["youtube"],
    sql: `select access_token, refresh_token, expires_at
      from youtube_auth
      where service = ?
      limit 1`,
  });
  const auth = typedRow<YouTubeAuthRow>(result.rows);

  if (!auth) {
    throw new ApiError("youtube_not_authenticated", "YouTube is not authenticated", 400);
  }

  const expiresAt = new Date(auth.expires_at).getTime();
  const refreshWindowMs = 60_000;

  if (expiresAt - refreshWindowMs > Date.now()) {
    return auth.access_token;
  }

  const data = await requestToken({
    client_id: (await readEnvs(["YOUTUBE_CLIENT_ID"])).YOUTUBE_CLIENT_ID,
    client_secret: (await readEnvs(["YOUTUBE_CLIENT_SECRET"])).YOUTUBE_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: auth.refresh_token,
  });

  // Google omits refresh_token on refresh; keep the stored one.
  const refreshToken = data.refresh_token ?? auth.refresh_token;
  await upsertYouTubeAuth(data.access_token, refreshToken, data.expires_in, data.scope);

  return data.access_token;
}

/**
 * Extract a stable YouTube channel id (`UC…`) from a stored social URL. ONLY the
 * `…/channel/UC…` shape yields a channel id directly from the URL; a `/user/<name>` or
 * `/@handle` URL needs an API lookup to resolve, so those return `null` here — as does
 * any URL with no `/channel/UC…` segment (a `/watch` link, junk). Used by the capture
 * queue's artist-own-channel trust signal, where an API round-trip per finding is off
 * the table.
 */
export function extractYoutubeChannelId(url: string): string | null {
  const match = url.match(/\/channel\/(UC[A-Za-z0-9_-]+)/);

  return match?.[1] ?? null;
}

async function requestToken(params: Record<string, string>): Promise<YouTubeTokenResponse> {
  const env = await readEnvs(["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET"]);
  const response = await fetch(googleTokenUrl, {
    body: new URLSearchParams({
      client_id: env.YOUTUBE_CLIENT_ID,
      client_secret: env.YOUTUBE_CLIENT_SECRET,
      ...params,
    }),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });

  if (!response.ok) {
    const body = await response.text();
    const detail = body
      ? `${response.status} ${response.statusText} - ${body}`
      : `${response.status} ${response.statusText}`;

    throw new ApiError("youtube_token_failed", `YouTube token request failed: ${detail}`, 400);
  }

  return (await response.json()) as YouTubeTokenResponse;
}

async function upsertYouTubeAuth(
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
  scope: string,
): Promise<void> {
  const db = await getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresIn * 1000);

  await db.execute({
    args: ["youtube", accessToken, refreshToken, expiresAt.toISOString(), scope, now.toISOString()],
    sql: `insert into youtube_auth (
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
