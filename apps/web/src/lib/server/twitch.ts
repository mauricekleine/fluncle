// Our own Twitch OAuth + token machinery for the /reach Tier-2 follower total. Mirrors
// the YouTube token path (youtube.ts): the durable refresh token lives in twitch_auth
// (server-side), and we mint a short-lived access token on demand for the reach
// collector's Helix `channels/followers` read. Twitch's follower total now requires the
// broadcaster's OWN user token with `moderator:read:followers` (an app token no longer
// suffices), so this is a full user-OAuth-with-refresh leg, DORMANT until the operator
// connects. Identity login stays Spotify-only; Twitch is purely a stats source.
//
// The redirect URI is derived from the request origin (like mixcloud.ts) rather than an
// env var — the operator registers that exact callback URL in the Twitch dev console.

import { getDb, typedRow } from "./db";
import { type FetchImpl, readOptionalEnv } from "./env";
import { ApiError } from "./spotify";

const twitchAuthorizeUrl = "https://id.twitch.tv/oauth2/authorize";
const twitchTokenUrl = "https://id.twitch.tv/oauth2/token";

// The single scope the follower-total read needs. `moderator:read:followers` on the
// broadcaster's own token returns the total (Twitch change-log 2023-09-06).
const twitchScopes = ["moderator:read:followers"];

type TwitchTokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  // Twitch returns the granted scopes as an ARRAY (unlike Google's space string).
  scope?: string[];
};

type TwitchAuthRow = {
  access_token: string;
  expires_at: string;
  refresh_token: string;
};

/** The callback URL, derived from the request origin (registered in the dev console). */
export function twitchRedirectUri(origin: string): string {
  return `${origin}/api/admin/twitch/auth/callback`;
}

/**
 * Read the Twitch client id/secret, throwing a clean `ApiError` (→ a 400 JSON body via
 * apiErrorResponse, never a crash) when the leg is unconfigured. OPTIONAL env: the whole
 * Twitch reach leg is DORMANT until these are set.
 */
async function readTwitchCreds(): Promise<{ clientId: string; clientSecret: string }> {
  const clientId = await readOptionalEnv("TWITCH_CLIENT_ID");
  const clientSecret = await readOptionalEnv("TWITCH_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    throw new ApiError(
      "twitch_not_configured",
      "Twitch OAuth is not configured (TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET unset)",
      400,
    );
  }

  return { clientId, clientSecret };
}

/** The public client id alone (the collector's Helix `Client-Id` header). */
export async function readTwitchClientId(): Promise<string> {
  const clientId = await readOptionalEnv("TWITCH_CLIENT_ID");

  if (!clientId) {
    throw new ApiError("twitch_not_configured", "Twitch OAuth is not configured", 400);
  }

  return clientId;
}

export async function buildTwitchAuthUrl(state: string, redirectUri: string): Promise<string> {
  const { clientId } = await readTwitchCreds();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: twitchScopes.join(" "),
    state,
  });

  return `${twitchAuthorizeUrl}?${params.toString()}`;
}

/**
 * The raw Twitch token POST (code exchange OR refresh), fetch injected so the refresh
 * path is unit-testable. Reads the creds off env and throws a clean `ApiError` on a
 * non-2xx (the detail is safe to surface: it never contains a secret).
 */
export async function requestTwitchToken(
  params: Record<string, string>,
  fetchImpl: FetchImpl = fetch,
): Promise<TwitchTokenResponse> {
  const { clientId, clientSecret } = await readTwitchCreds();
  const response = await fetchImpl(twitchTokenUrl, {
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      ...params,
    }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });

  if (!response.ok) {
    const body = await response.text();

    throw new ApiError(
      "twitch_token_failed",
      `Twitch token request failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`,
      400,
    );
  }

  return (await response.json()) as TwitchTokenResponse;
}

export async function exchangeCodeForTwitchToken(code: string, redirectUri: string): Promise<void> {
  const data = await requestTwitchToken({
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  if (!data.refresh_token) {
    throw new ApiError("twitch_token_failed", "Twitch did not return a refresh token", 400);
  }

  await upsertTwitchAuth(data.access_token, data.refresh_token, data.expires_in, data.scope ?? []);
}

/**
 * A valid Twitch access token, refreshing via the stored refresh token when the current
 * one is within ~60s of expiry. Mirrors getYouTubeAccessToken.
 */
export async function getTwitchAccessToken(): Promise<string> {
  const db = await getDb();
  const result = await db.execute({
    args: ["twitch"],
    sql: `select access_token, refresh_token, expires_at from twitch_auth where service = ? limit 1`,
  });
  const auth = typedRow<TwitchAuthRow>(result.rows);

  if (!auth) {
    throw new ApiError("twitch_not_authenticated", "Twitch is not authenticated", 400);
  }

  const expiresAt = new Date(auth.expires_at).getTime();
  const refreshWindowMs = 60_000;

  if (expiresAt - refreshWindowMs > Date.now()) {
    return auth.access_token;
  }

  const data = await requestTwitchToken({
    grant_type: "refresh_token",
    refresh_token: auth.refresh_token,
  });
  // Twitch may omit refresh_token on refresh; keep the stored one.
  const refreshToken = data.refresh_token ?? auth.refresh_token;
  await upsertTwitchAuth(data.access_token, refreshToken, data.expires_in, data.scope ?? []);

  return data.access_token;
}

async function upsertTwitchAuth(
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
  scope: string[],
): Promise<void> {
  const db = await getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresIn * 1000);

  await db.execute({
    args: [
      "twitch",
      accessToken,
      refreshToken,
      expiresAt.toISOString(),
      scope.join(" "),
      now.toISOString(),
    ],
    sql: `insert into twitch_auth (service, access_token, refresh_token, expires_at, scope, updated_at)
      values (?, ?, ?, ?, ?, ?)
      on conflict(service) do update set
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        scope = excluded.scope,
        updated_at = excluded.updated_at`,
  });
}
