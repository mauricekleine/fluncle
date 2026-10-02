import { getDb, typedRow } from "./db";
import { type FetchImpl, readOptionalEnv } from "./env";
import { ApiError } from "./api-error";
import {
  oauthRequest,
  oauthTokenRequest,
  refreshOAuthToken,
  runOAuthEffect,
} from "./oauth-token-refresh";

const instagramAuthorizeUrl = "https://www.instagram.com/oauth/authorize";
const instagramCodeExchangeUrl = "https://api.instagram.com/oauth/access_token";
const instagramGraphBase = "https://graph.instagram.com";

const instagramScopes = ["instagram_business_basic"];

type InstagramShortTokenResponse = {
  access_token?: string;
  user_id?: number | string;

  data?: { access_token?: string; user_id?: number | string }[];
};

type InstagramLongTokenResponse = { access_token?: string; expires_in?: number };

type InstagramAuthRow = { access_token: string; expires_at: string };

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

export async function exchangeInstagramCodeForShortToken(
  code: string,
  redirectUri: string,
  fetchImpl: FetchImpl = fetch,
): Promise<string> {
  const { clientId, clientSecret } = await readInstagramCreds();
  return runOAuthEffect(
    oauthRequest(
      instagramCodeExchangeUrl,
      {
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      },
      async (response) => {
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
          throw new ApiError(
            "instagram_token_failed",
            "Instagram returned no short-lived token",
            400,
          );
        }

        return accessToken;
      },
      fetchImpl,
    ),
  );
}

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
  return runOAuthEffect(
    oauthTokenRequest<InstagramLongTokenResponse>(
      `${instagramGraphBase}/access_token?${params.toString()}`,
      {},
      "instagram_token_failed",
      "Instagram long-lived exchange",
      fetchImpl,
    ),
  );
}

function refreshInstagramTokenEffect(accessToken: string, fetchImpl: FetchImpl = fetch) {
  const params = new URLSearchParams({
    access_token: accessToken,
    grant_type: "ig_refresh_token",
  });
  return oauthTokenRequest<InstagramLongTokenResponse>(
    `${instagramGraphBase}/refresh_access_token?${params.toString()}`,
    {},
    "instagram_token_failed",
    "Instagram token refresh",
    fetchImpl,
  );
}

export async function refreshInstagramToken(
  accessToken: string,
  fetchImpl: FetchImpl = fetch,
): Promise<InstagramLongTokenResponse> {
  return runOAuthEffect(refreshInstagramTokenEffect(accessToken, fetchImpl));
}

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

async function readInstagramAuthRow(): Promise<InstagramAuthRow | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: ["instagram"],
    sql: `select access_token, expires_at from instagram_auth where service = ? limit 1`,
  });
  return typedRow<InstagramAuthRow>(result.rows);
}

export async function getInstagramAccessToken(): Promise<string> {
  return refreshOAuthToken({
    clear: async () => {
      const db = await getDb();
      await db.execute({
        args: ["instagram"],
        sql: "delete from instagram_auth where service = ?",
      });
    },
    notAuthenticated: new ApiError(
      "instagram_not_authenticated",
      "Instagram is not authenticated",
      400,
    ),
    read: readInstagramAuthRow,
    reauthRequired: new ApiError(
      "instagram_reauth_required",
      "Instagram needs reconnecting. Reconnect from the board.",
      401,
    ),
    refresh: (auth) => refreshInstagramTokenEffect(auth.access_token),
    refreshWindowMs: 24 * 60 * 60 * 1000,
    write: async (data, auth) => {
      if (!data.access_token) {
        return auth.access_token;
      }
      await upsertInstagramAuth(data.access_token, data.expires_in ?? 0);
      return data.access_token;
    },
  });
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
