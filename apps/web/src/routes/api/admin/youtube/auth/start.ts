import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { hasBearerHeader, requireOperator } from "../../../../../lib/server/env";
import { apiErrorResponse } from "../../../../../lib/server/http-errors";
import { mintOauthState } from "../../../../../lib/server/oauth-state";
import { buildYouTubeAuthUrl } from "../../../../../lib/server/youtube";

// Admin-gated start of our own YouTube OAuth (mixtape video distribution).
// Mirrors the Spotify start route; the callback verifies the same signed state.
export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    try {
      // Browser start ⇒ the state is pinned to this browser by a nonce cookie; CLI
      // start (Bearer) ⇒ unbound (oauth-state.ts).
      const { setCookie, state } = await mintOauthState("youtube-auth", {
        bindToBrowser: !hasBearerHeader(request),
      });
      const authUrl = await buildYouTubeAuthUrl(state);

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

export const Route = createFileRoute("/api/admin/youtube/auth/start")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
