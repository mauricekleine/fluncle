import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { requireOperator, signState } from "../../../../../lib/server/env";
import { apiErrorResponse } from "../../../../../lib/server/http-errors";
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
      const state = await signState({
        iat: Date.now(),
        nonce: crypto.randomUUID(),
        purpose: "youtube-auth",
      });
      const authUrl = await buildYouTubeAuthUrl(state);

      return Response.json({
        authUrl,
        ok: true,
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/youtube/auth/start")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
