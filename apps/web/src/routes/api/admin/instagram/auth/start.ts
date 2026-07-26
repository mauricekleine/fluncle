import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { hasBearerHeader, requireOperator } from "../../../../../lib/server/env";
import { buildInstagramAuthUrl, instagramRedirectUri } from "../../../../../lib/server/instagram";
import { apiErrorResponse } from "../../../../../lib/server/http-errors";
import { mintOauthState } from "../../../../../lib/server/oauth-state";

// Admin-gated start of our own Instagram OAuth (the /reach follower count), via the
// "Instagram API with Instagram Login" business flow. Mirrors the Mixcloud/YouTube
// start route; the callback verifies the same signed state. The token is provisioned +
// stored server-side — the CLI never holds the durable credential. Instagram is a stats
// source, not an admin identity provider (login stays Spotify-only). Unconfigured (no
// client id/secret) answers a clean 400, never a crash.
export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    try {
      // Browser start ⇒ the state is pinned to this browser by a nonce cookie; CLI
      // start (Bearer) ⇒ unbound (oauth-state.ts).
      const { setCookie, state } = await mintOauthState("instagram-auth", {
        bindToBrowser: !hasBearerHeader(request),
      });
      const redirectUri = instagramRedirectUri(new URL(request.url).origin);
      const authUrl = await buildInstagramAuthUrl(state, redirectUri);

      return Response.json(
        { authUrl, ok: true },
        setCookie ? { headers: { "Set-Cookie": setCookie } } : undefined,
      );
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/instagram/auth/start")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
