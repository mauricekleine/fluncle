import { Effect } from "effect";
import { getDb, typedRow } from "./db";
import { type FetchImpl, readOptionalEnv } from "./env";
import { ApiError } from "./api-error";
import {
  oauthPromise,
  oauthTokenRequest,
  refreshOAuthToken,
  runOAuthEffect,
} from "./oauth-token-refresh";

const twitchAuthorizeUrl = "https://id.twitch.tv/oauth2/authorize";
const twitchTokenUrl = "https://id.twitch.tv/oauth2/token";

const twitchScopes = ["moderator:read:followers"];

type TwitchTokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;

  scope?: string[];
};

type TwitchAuthRow = {
  access_token: string;
  expires_at: string;
  refresh_token: string;
};

export function twitchRedirectUri(origin: string): string {
  return `${origin}/api/admin/twitch/auth/callback`;
}

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

const requestTwitchTokenEffect = Effect.fnUntraced(function* (
  params: Record<string, string>,
  fetchImpl: FetchImpl = fetch,
) {
  const { clientId, clientSecret } = yield* oauthPromise(readTwitchCreds);
  return yield* oauthTokenRequest<TwitchTokenResponse>(
    twitchTokenUrl,
    {
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        ...params,
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    },
    "twitch_token_failed",
    "Twitch token request",
    fetchImpl,
    (response, data) =>
      (response.status === 400 || response.status === 401) &&
      data?.message === "Invalid refresh token",
  );
});

export async function requestTwitchToken(
  params: Record<string, string>,
  fetchImpl: FetchImpl = fetch,
): Promise<TwitchTokenResponse> {
  return runOAuthEffect(requestTwitchTokenEffect(params, fetchImpl));
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

async function readTwitchAuthRow(): Promise<TwitchAuthRow | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: ["twitch"],
    sql: `select access_token, refresh_token, expires_at from twitch_auth where service = ? limit 1`,
  });
  return typedRow<TwitchAuthRow>(result.rows);
}

export async function getTwitchAccessToken(): Promise<string> {
  return refreshOAuthToken({
    clear: async () => {
      const db = await getDb();
      await db.execute({ args: ["twitch"], sql: "delete from twitch_auth where service = ?" });
    },
    notAuthenticated: new ApiError("twitch_not_authenticated", "Twitch is not authenticated", 400),
    read: readTwitchAuthRow,
    reauthRequired: new ApiError(
      "twitch_reauth_required",
      "Twitch needs reconnecting. Reconnect from the board.",
      401,
    ),
    refresh: (auth) =>
      requestTwitchTokenEffect({ grant_type: "refresh_token", refresh_token: auth.refresh_token }),
    refreshWindowMs: 60_000,
    write: async (data, auth) => {
      await upsertTwitchAuth(
        data.access_token,
        data.refresh_token ?? auth.refresh_token,
        data.expires_in,
        data.scope ?? [],
      );
      return data.access_token;
    },
  });
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
