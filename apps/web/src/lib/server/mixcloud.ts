// Our own Mixcloud OAuth, kept server-side like spotify.ts / youtube.ts — the CLI
// stays a thin client. Mixcloud distribution uploads the bytes CLI-direct (the
// Worker can't proxy a multi-GB master), but the CREDENTIAL lives here: the Worker
// runs the OAuth code exchange, stores the durable access token in mixcloud_auth,
// and hands it to the CLI just-in-time (the /mixcloud/token route) for the upload.
// Mixcloud tokens don't expire and there's no refresh token, so this is simpler
// than the Spotify/YouTube refresh dance.

import { getDb, typedRow } from "./db";
import { readEnvs } from "./env";
import { ApiError } from "./spotify";

const mixcloudAuthorizeUrl = "https://www.mixcloud.com/oauth/authorize/";
const mixcloudTokenUrl = "https://www.mixcloud.com/oauth/access_token/";

type MixcloudTokenResponse = { access_token?: string };

type MixcloudAuthRow = { access_token: string };

export async function buildMixcloudAuthUrl(state: string): Promise<string> {
  const env = await readEnvs(["MIXCLOUD_CLIENT_ID", "MIXCLOUD_REDIRECT_URI"]);
  const params = new URLSearchParams({
    client_id: env.MIXCLOUD_CLIENT_ID,
    redirect_uri: env.MIXCLOUD_REDIRECT_URI,
    state,
  });

  return `${mixcloudAuthorizeUrl}?${params.toString()}`;
}

export async function exchangeCodeForMixcloudToken(code: string): Promise<void> {
  const env = await readEnvs([
    "MIXCLOUD_CLIENT_ID",
    "MIXCLOUD_CLIENT_SECRET",
    "MIXCLOUD_REDIRECT_URI",
  ]);
  const params = new URLSearchParams({
    client_id: env.MIXCLOUD_CLIENT_ID,
    client_secret: env.MIXCLOUD_CLIENT_SECRET,
    code,
    redirect_uri: env.MIXCLOUD_REDIRECT_URI,
  });

  // Mixcloud's token endpoint is a GET with query params, returning { access_token }.
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

/** The stored Mixcloud access token (handed to the CLI for the direct upload). */
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
