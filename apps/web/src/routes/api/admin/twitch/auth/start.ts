import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { hasBearerHeader, requireOperator } from "../../../../../lib/server/env";
import { apiErrorResponse } from "../../../../../lib/server/http-errors";
import { mintOauthState } from "../../../../../lib/server/oauth-state";
import { buildTwitchAuthUrl, twitchRedirectUri } from "../../../../../lib/server/twitch";

// Admin-gated start of our own Twitch OAuth (the /reach follower total). Mirrors the
// Mixcloud/YouTube start route; the callback verifies the same signed state. The token
// is provisioned + stored server-side — the CLI never holds the durable credential.
// Twitch is a stats source, not an admin identity provider (login stays Spotify-only).
// Unconfigured (no client id/secret) answers a clean 400, never a crash.
export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    try {
      // Browser start ⇒ the state is pinned to this browser by a nonce cookie; CLI
      // start (Bearer) ⇒ unbound (oauth-state.ts).
      const { setCookie, state } = await mintOauthState("twitch-auth", {
        bindToBrowser: !hasBearerHeader(request),
      });
      const redirectUri = twitchRedirectUri(new URL(request.url).origin);
      const authUrl = await buildTwitchAuthUrl(state, redirectUri);

      return Response.json(
        { authUrl, ok: true },
        setCookie ? { headers: { "Set-Cookie": setCookie } } : undefined,
      );
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/twitch/auth/start")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
