import { getDb, typedRow } from "./db";
import { readEnvs } from "./env";
import { ApiError } from "./spotify";

const mixcloudAuthorizeUrl = "https://www.mixcloud.com/oauth/authorize/";
const mixcloudTokenUrl = "https://www.mixcloud.com/oauth/access_token/";

type MixcloudTokenResponse = { access_token?: string };

type MixcloudAuthRow = { access_token: string };

export function mixcloudRedirectUri(origin: string): string {
  return `${origin}/api/admin/mixcloud/auth/callback`;
}

export async function buildMixcloudAuthUrl(state: string, redirectUri: string): Promise<string> {
  const env = await readEnvs(["MIXCLOUD_CLIENT_ID"]);
  const params = new URLSearchParams({
    client_id: env.MIXCLOUD_CLIENT_ID,
    redirect_uri: redirectUri,
    state,
  });

  return `${mixcloudAuthorizeUrl}?${params.toString()}`;
}

export async function exchangeCodeForMixcloudToken(
  code: string,
  redirectUri: string,
): Promise<void> {
  const env = await readEnvs(["MIXCLOUD_CLIENT_ID", "MIXCLOUD_CLIENT_SECRET"]);
  const params = new URLSearchParams({
    client_id: env.MIXCLOUD_CLIENT_ID,
    client_secret: env.MIXCLOUD_CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
  });

  const response = await fetch(`${mixcloudTokenUrl}?${params.toString()}`);

  if (!response.ok) {
    const body = await response.text();

    throw new ApiError(
      "mixcloud_token_failed",
      `Mixcloud token request failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`,
      400,
    );
  }

  const data = (await response.json()) as MixcloudTokenResponse;

  if (!data.access_token) {
    throw new ApiError("mixcloud_token_failed", "Mixcloud returned no access token", 400);
  }

  await upsertMixcloudAuth(data.access_token);
}

export async function getMixcloudAccessToken(): Promise<string> {
  const db = await getDb();
  const result = await db.execute({
    args: ["mixcloud"],
    sql: `select access_token from mixcloud_auth where service = ? limit 1`,
  });
  const auth = typedRow<MixcloudAuthRow>(result.rows);

  if (!auth) {
    throw new ApiError("mixcloud_not_authenticated", "Mixcloud is not authenticated", 400);
  }

  return auth.access_token;
}

async function upsertMixcloudAuth(accessToken: string): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();

  await db.execute({
    args: ["mixcloud", accessToken, now],
    sql: `insert into mixcloud_auth (service, access_token, updated_at)
      values (?, ?, ?)
      on conflict(service) do update set
        access_token = excluded.access_token,
        updated_at = excluded.updated_at`,
  });
}
