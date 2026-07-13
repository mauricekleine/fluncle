// Our own Instagram OAuth + token machinery for the /reach Tier-2 follower count, via
// the "Instagram API with Instagram Login" business flow (NOT the Facebook-Login
// variant — no Pages, no Business Manager linkage; the operator logs in with the
// Instagram account itself). The token model differs from Spotify/YouTube: there is NO
// refresh_token. The callback exchanges the code for a SHORT-lived token, immediately
// upgrades it to a 60-day LONG-lived token, and stores THAT; getInstagramAccessToken
// then refreshes the long-lived token IN PLACE (graph.instagram.com/refresh_access_token)
// when it nears expiry. So instagram_auth carries just the durable token + its expiry.
// DORMANT until the operator connects. Identity login stays Spotify-only.
//
// The redirect URI is derived from the request origin (like mixcloud.ts); the operator
// registers that exact callback URL in the Meta app dashboard.

import { getDb, typedRow } from "./db";
import { type FetchImpl, readOptionalEnv } from "./env";
import { ApiError } from "./spotify";

const instagramAuthorizeUrl = "https://www.instagram.com/oauth/authorize";
const instagramCodeExchangeUrl = "https://api.instagram.com/oauth/access_token";
const instagramGraphBase = "https://graph.instagram.com";

// instagram_business_basic unlocks the account's own fields incl. followers_count.
const instagramScopes = ["instagram_business_basic"];

type InstagramShortTokenResponse = {
  access_token?: string;
  user_id?: number | string;
  // The code-exchange body can arrive flat OR wrapped in a `data: [...]` array.
  data?: { access_token?: string; user_id?: number | string }[];
};

type InstagramLongTokenResponse = { access_token?: string; expires_in?: number };

type InstagramAuthRow = { access_token: string; expires_at: string };

/** The callback URL, derived from the request origin (registered in the Meta app). */
export function instagramRedirectUri(origin: string): string {
  return `${origin}/api/admin/instagram/auth/callback`;
}

async function readInstagramCreds(): Promise<{ clientId: string; clientSecret: string }> {
  const clientId = await readOptionalEnv("INSTAGRAM_CLIENT_ID");
  const clientSecret = await readOptionalEnv("INSTAGRAM_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    throw new ApiError(
      "instagram_not_configured",
      "Instagram OAuth is not configured (INSTAGRAM_CLIENT_ID / INSTAGRAM_CLIENT_SECRET unset)",
      400,
    );
  }

  return { clientId, clientSecret };
}

export async function buildInstagramAuthUrl(state: string, redirectUri: string): Promise<string> {
  const { clientId } = await readInstagramCreds();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: instagramScopes.join(","),
    state,
  });

  return `${instagramAuthorizeUrl}?${params.toString()}`;
}

/**
 * Exchange the authorization code for a short-lived token (fetch injected for testing).
 * The response can be flat (`{ access_token }`) or wrapped (`{ data: [{ access_token }] }`),
 * so both shapes are read.
 */
export async function exchangeInstagramCodeForShortToken(
  code: string,
  redirectUri: string,
  fetchImpl: FetchImpl = fetch,
): Promise<string> {
  const { clientId, clientSecret } = await readInstagramCreds();
  const response = await fetchImpl(instagramCodeExchangeUrl, {
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });

  if (!response.ok) {
    const body = await response.text();

    throw new ApiError(
      "instagram_token_failed",
      `Instagram code exchange failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`,
      400,
    );
  }

  const data = (await response.json()) as InstagramShortTokenResponse;
  const accessToken = data.access_token ?? data.data?.[0]?.access_token;

  if (!accessToken) {
    throw new ApiError("instagram_token_failed", "Instagram returned no short-lived token", 400);
  }

  return accessToken;
}

/**
 * Upgrade a short-lived token to a 60-day long-lived token (fetch injected for testing).
 * This is a GET with the app secret, so it runs server-side only.
 */
export async function exchangeInstagramForLongToken(
  shortToken: string,
  fetchImpl: FetchImpl = fetch,
): Promise<InstagramLongTokenResponse> {
  const { clientSecret } = await readInstagramCreds();
  const params = new URLSearchParams({
    access_token: shortToken,
    client_secret: clientSecret,
    grant_type: "ig_exchange_token",
  });
  const response = await fetchImpl(`${instagramGraphBase}/access_token?${params.toString()}`);

  if (!response.ok) {
    const body = await response.text();

    throw new ApiError(
      "instagram_token_failed",
      `Instagram long-lived exchange failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`,
      400,
    );
  }

  return (await response.json()) as InstagramLongTokenResponse;
}

/**
 * Refresh an existing long-lived token in place (fetch injected so the refresh path is
 * unit-testable). No client secret needed — the current token authorizes the refresh.
 */
export async function refreshInstagramToken(
  accessToken: string,
  fetchImpl: FetchImpl = fetch,
): Promise<InstagramLongTokenResponse> {
  const params = new URLSearchParams({
    access_token: accessToken,
    grant_type: "ig_refresh_token",
  });
  const response = await fetchImpl(
    `${instagramGraphBase}/refresh_access_token?${params.toString()}`,
  );

  if (!response.ok) {
    const body = await response.text();

    throw new ApiError(
      "instagram_token_failed",
      `Instagram token refresh failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`,
      400,
    );
  }

  return (await response.json()) as InstagramLongTokenResponse;
}

/** Run the full callback path: code → short token → long token → store it. */
export async function exchangeCodeForInstagramToken(
  code: string,
  redirectUri: string,
): Promise<void> {
  const shortToken = await exchangeInstagramCodeForShortToken(code, redirectUri);
  const long = await exchangeInstagramForLongToken(shortToken);

  if (!long.access_token) {
    throw new ApiError("instagram_token_failed", "Instagram returned no long-lived token", 400);
  }

  await upsertInstagramAuth(long.access_token, long.expires_in ?? 0);
}

/**
 * A valid long-lived Instagram token, refreshed IN PLACE when it is within a day of
 * expiry (the refresh endpoint requires the token be ≥24h old and unexpired; a 1-day
 * window keeps it comfortably inside that band on a daily collector cadence).
 */
export async function getInstagramAccessToken(): Promise<string> {
  const db = await getDb();
  const result = await db.execute({
    args: ["instagram"],
    sql: `select access_token, expires_at from instagram_auth where service = ? limit 1`,
  });
  const auth = typedRow<InstagramAuthRow>(result.rows);

  if (!auth) {
    throw new ApiError("instagram_not_authenticated", "Instagram is not authenticated", 400);
  }

  const expiresAt = new Date(auth.expires_at).getTime();
  const refreshWindowMs = 24 * 60 * 60 * 1000;

  if (expiresAt - refreshWindowMs > Date.now()) {
    return auth.access_token;
  }

  const refreshed = await refreshInstagramToken(auth.access_token);

  if (!refreshed.access_token) {
    // The refresh failed to return a token but did not throw; keep the stored one.
    return auth.access_token;
  }

  await upsertInstagramAuth(refreshed.access_token, refreshed.expires_in ?? 0);

  return refreshed.access_token;
}

async function upsertInstagramAuth(accessToken: string, expiresIn: number): Promise<void> {
  const db = await getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresIn * 1000);

  await db.execute({
    args: ["instagram", accessToken, expiresAt.toISOString(), now.toISOString()],
    sql: `insert into instagram_auth (service, access_token, expires_at, updated_at)
      values (?, ?, ?, ?)
      on conflict(service) do update set
        access_token = excluded.access_token,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at`,
  });
}
