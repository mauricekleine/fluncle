import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { hasBearerHeader, requireOperator } from "../../../../../lib/server/env";
import { apiErrorResponse } from "../../../../../lib/server/http-errors";
import { mintOauthState } from "../../../../../lib/server/oauth-state";
import { buildSpotifyAuthUrl } from "../../../../../lib/server/spotify";

export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    try {
      // Browser start (grant cookie, no Bearer) ⇒ the state is pinned to this
      // browser via the nonce cookie; CLI start (Bearer) ⇒ unbound (oauth-state.ts).
      const { setCookie, state } = await mintOauthState("spotify-auth", {
        bindToBrowser: !hasBearerHeader(request),
      });
      const authUrl = await buildSpotifyAuthUrl(state);

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

export const Route = createFileRoute("/api/admin/spotify/auth/start")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
