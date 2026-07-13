// Our own TikTok OAuth + token machinery for the /reach Tier-2 follower + likes totals.
// Mirrors the YouTube token path (youtube.ts): the durable refresh token lives in
// tiktok_auth (server-side), and we mint a short-lived access token on demand for the
// reach collector's Display API `user/info` read. TikTok's `user.info.stats` scope is
// own-account-only (Postiz exposes no analytics), so this is a full user-OAuth-with-
// refresh leg, DORMANT until the operator connects. Identity login stays Spotify-only.
//
// The redirect URI is derived from the request origin (like mixcloud.ts); the operator
// registers that exact callback URL in the TikTok developer app. Note TikTok's OAuth
// parameter is `client_key` (not `client_id`), and its token endpoint is a form POST
// returning snake_case tokens.

import { getDb, typedRow } from "./db";
import { type FetchImpl, readOptionalEnv } from "./env";
import { ApiError } from "./spotify";

const tiktokAuthorizeUrl = "https://www.tiktok.com/v2/auth/authorize/";
const tiktokTokenUrl = "https://open.tiktokapis.com/v2/oauth/token/";

// user.info.basic is required to open the user endpoint; user.info.stats unlocks the
// follower_count / likes_count fields the reach collector reads.
const tiktokScopes = ["user.info.basic", "user.info.stats"];

type TiktokTokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  // TikTok surfaces token errors in the body (200 or 4xx) as a top-level error code.
  error?: string;
  error_description?: string;
};

type TiktokAuthRow = {
  access_token: string;
  expires_at: string;
  refresh_token: string;
};

/** The callback URL, derived from the request origin (registered in the TikTok app). */
export function tiktokRedirectUri(origin: string): string {
  return `${origin}/api/admin/tiktok/auth/callback`;
}

async function readTiktokCreds(): Promise<{ clientKey: string; clientSecret: string }> {
  const clientKey = await readOptionalEnv("TIKTOK_CLIENT_KEY");
  const clientSecret = await readOptionalEnv("TIKTOK_CLIENT_SECRET");

  if (!clientKey || !clientSecret) {
    throw new ApiError(
      "tiktok_not_configured",
      "TikTok OAuth is not configured (TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET unset)",
      400,
    );
  }

  return { clientKey, clientSecret };
}

export async function buildTiktokAuthUrl(state: string, redirectUri: string): Promise<string> {
  const { clientKey } = await readTiktokCreds();
  const params = new URLSearchParams({
    client_key: clientKey,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: tiktokScopes.join(","),
    state,
  });

  return `${tiktokAuthorizeUrl}?${params.toString()}`;
}

/**
 * The raw TikTok token POST (code exchange OR refresh), fetch injected so the refresh
 * path is unit-testable. TikTok can return its error in the BODY with a 200, so this
 * checks the parsed `error` field as well as the HTTP status.
 */
export async function requestTiktokToken(
  params: Record<string, string>,
  fetchImpl: FetchImpl = fetch,
): Promise<TiktokTokenResponse> {
  const { clientKey, clientSecret } = await readTiktokCreds();
  const response = await fetchImpl(tiktokTokenUrl, {
    body: new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      ...params,
    }),
    headers: {
      "Cache-Control": "no-cache",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
  const data = (await response.json().catch(() => ({}))) as TiktokTokenResponse;

  if (!response.ok || data.error) {
    const detail =
      data.error_description ?? data.error ?? `${response.status} ${response.statusText}`;

    throw new ApiError("tiktok_token_failed", `TikTok token request failed: ${detail}`, 400);
  }

  if (!data.access_token) {
    throw new ApiError("tiktok_token_failed", "TikTok returned no access token", 400);
  }

  return data;
}

export async function exchangeCodeForTiktokToken(code: string, redirectUri: string): Promise<void> {
  const data = await requestTiktokToken({
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  if (!data.refresh_token) {
    throw new ApiError("tiktok_token_failed", "TikTok did not return a refresh token", 400);
  }

  await upsertTiktokAuth(
    data.access_token ?? "",
    data.refresh_token,
    data.expires_in ?? 0,
    data.scope ?? "",
  );
}

/**
 * A valid TikTok access token, refreshing via the stored refresh token when the current
 * one is within ~60s of expiry. Mirrors getYouTubeAccessToken.
 */
export async function getTiktokAccessToken(): Promise<string> {
  const db = await getDb();
  const result = await db.execute({
    args: ["tiktok"],
    sql: `select access_token, refresh_token, expires_at from tiktok_auth where service = ? limit 1`,
  });
  const auth = typedRow<TiktokAuthRow>(result.rows);

  if (!auth) {
    throw new ApiError("tiktok_not_authenticated", "TikTok is not authenticated", 400);
  }

  const expiresAt = new Date(auth.expires_at).getTime();
  const refreshWindowMs = 60_000;

  if (expiresAt - refreshWindowMs > Date.now()) {
    return auth.access_token;
  }

  const data = await requestTiktokToken({
    grant_type: "refresh_token",
    refresh_token: auth.refresh_token,
  });
  const refreshToken = data.refresh_token ?? auth.refresh_token;
  await upsertTiktokAuth(
    data.access_token ?? "",
    refreshToken,
    data.expires_in ?? 0,
    data.scope ?? "",
  );

  return data.access_token ?? "";
}

async function upsertTiktokAuth(
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
  scope: string,
): Promise<void> {
  const db = await getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresIn * 1000);

  await db.execute({
    args: ["tiktok", accessToken, refreshToken, expiresAt.toISOString(), scope, now.toISOString()],
    sql: `insert into tiktok_auth (service, access_token, refresh_token, expires_at, scope, updated_at)
      values (?, ?, ?, ?, ?, ?)
      on conflict(service) do update set
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        scope = excluded.scope,
        updated_at = excluded.updated_at`,
  });
}
