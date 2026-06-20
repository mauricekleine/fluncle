// Last.fm desktop-auth, the two-step CLI flow (mirrors `auth youtube`/`mixcloud` as
// a thin trigger, but Last.fm has no provider→callback redirect, so step 3 is a
// second CLI call rather than a server-side callback):
//
//   1. `fluncle admin auth lastfm` → the Worker runs auth.getToken and returns an
//      authorize URL. Maurice opens it (logged in as `fluncle`) and clicks
//      "Yes, allow access".
//   2. `fluncle admin auth lastfm --token <token>` → the Worker runs auth.getSession
//      and returns the durable session key. Maurice sets it as the
//      LASTFM_SESSION_KEY Worker secret.
//
// The CLI never holds the API key or shared secret — those live as Worker secrets;
// the signed calls happen server-side. The session key is printed once so Maurice
// can provision the secret (it's not persisted server-side — no schema change).

import { type LastfmAuthSessionResponse, type LastfmAuthStartResponse } from "@fluncle/contracts";
import { adminApiGet, adminApiPost } from "../api";

export async function authLastfmCommand(options: { token?: string }): Promise<void> {
  if (options.token?.trim()) {
    const response = await adminApiPost<LastfmAuthSessionResponse>(
      "/api/admin/lastfm/auth/session",
      { token: options.token.trim() },
    );

    console.log(`Last.fm connected as ${response.name || "fluncle"}.

Set this as the Worker secret LASTFM_SESSION_KEY (it does not expire):

${response.sessionKey}

  bun run --cwd apps/web wrangler secret put LASTFM_SESSION_KEY

Also store it in 1Password (Fluncle vault) alongside the API key + shared secret.`);

    return;
  }

  const response = await adminApiGet<LastfmAuthStartResponse>("/api/admin/lastfm/auth/start");

  console.log(`Open this Last.fm authorization URL (logged in as fluncle) and click "Yes, allow access":

${response.authUrl}

After approving, run this to mint the durable session key:

  fluncle admin auth lastfm --token ${response.token}`);
}
