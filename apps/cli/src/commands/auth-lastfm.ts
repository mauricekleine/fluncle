import { type LastfmAuthSessionResponse, type LastfmAuthStartResponse } from "@fluncle/contracts";
import { adminApiGet, adminApiPost } from "../api";

export async function authLastfmCommand(options: { token?: string }): Promise<void> {
  if (options.token?.trim()) {
    const response = await adminApiPost<LastfmAuthSessionResponse>(
      "/api/v1/admin/lastfm/auth/session",
      { token: options.token.trim() },
    );

    console.log(`Last.fm connected as ${response.name || "fluncle"}.

Set this as the Worker secret LASTFM_SESSION_KEY (it does not expire):

${response.sessionKey}

  bun run --cwd apps/web wrangler secret put LASTFM_SESSION_KEY

Also store it in your password manager alongside the API key + shared secret.`);

    return;
  }

  const response = await adminApiGet<LastfmAuthStartResponse>("/api/v1/admin/lastfm/auth/start");

  console.log(`Open this Last.fm authorization URL (logged in as fluncle) and click "Yes, allow access":

${response.authUrl}

After approving, run this to mint the durable session key:

  fluncle admin auth lastfm --token ${response.token}`);
}
