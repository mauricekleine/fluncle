import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { apiErrorResponse } from "../../../../../lib/server/http-errors";
import { mintOauthState } from "../../../../../lib/server/oauth-state";
import { buildSpotifyLoginUrl } from "../../../../../lib/server/spotify";

// The admin web login front door — PUBLIC by design (this is how you prove who
// you are; the sibling start.ts that requires a Bearer token is the publish-auth
// flow). Redirects to Spotify with identity scopes and a purpose-stamped state;
// the shared callback branches on purpose to verify the account and set the
// grant cookie. Reuses the already-registered redirect URI — no Spotify
// dashboard change needed.
export const serverHandlers: ApiHandlers = {
  GET: async () => {
    try {
      // Always browser-bound: this is the front door a human opens, so the nonce
      // cookie always rides along and the callback requires it back.
      const { setCookie, state } = await mintOauthState("admin-login", {
        bindToBrowser: true,
      });
      const authUrl = await buildSpotifyLoginUrl(state);

      return new Response(null, {
        headers: {
          Location: authUrl,
          ...(setCookie ? { "Set-Cookie": setCookie } : {}),
        },
        status: 302,
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/spotify/auth/login")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
