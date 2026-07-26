import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { hasBearerHeader, requireOperator } from "../../../../../lib/server/env";
import { apiErrorResponse } from "../../../../../lib/server/http-errors";
import { mintOauthState } from "../../../../../lib/server/oauth-state";
import { buildTikTokAuthUrl } from "../../../../../lib/server/tiktok";

// Admin-gated start of our own TikTok OAuth (Display API per-video metrics). Mirrors the
// YouTube start route; the callback verifies the same signed state (purpose tiktok-auth).
export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    try {
      // Browser start ⇒ the state is pinned to this browser by a nonce cookie; CLI
      // start (Bearer) ⇒ unbound (oauth-state.ts).
      const { setCookie, state } = await mintOauthState("tiktok-auth", {
        bindToBrowser: !hasBearerHeader(request),
      });
      const authUrl = await buildTikTokAuthUrl(state);

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

export const Route = createFileRoute("/api/admin/tiktok/auth/start")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
