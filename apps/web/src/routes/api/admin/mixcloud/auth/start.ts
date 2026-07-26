import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { hasBearerHeader, requireOperator } from "../../../../../lib/server/env";
import { apiErrorResponse } from "../../../../../lib/server/http-errors";
import { buildMixcloudAuthUrl, mixcloudRedirectUri } from "../../../../../lib/server/mixcloud";
import { mintOauthState } from "../../../../../lib/server/oauth-state";

// Admin-gated start of our own Mixcloud OAuth (mixtape audio distribution).
// Mirrors the Spotify/YouTube start route; the callback verifies the same signed
// state. The token is provisioned + stored server-side — the CLI never holds the
// durable credential.
export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    try {
      // Browser start ⇒ the state is pinned to this browser by a nonce cookie; CLI
      // start (Bearer) ⇒ unbound (oauth-state.ts).
      const { setCookie, state } = await mintOauthState("mixcloud-auth", {
        bindToBrowser: !hasBearerHeader(request),
      });
      const redirectUri = mixcloudRedirectUri(new URL(request.url).origin);
      const authUrl = await buildMixcloudAuthUrl(state, redirectUri);

      return Response.json(
        {
          authUrl,
          ok: true,
        },
        setCookie ? { headers: { "Set-Cookie": setCookie } } : undefined,
      );
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/mixcloud/auth/start")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
