import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { requireAdmin, signState } from "../../../../../lib/server/env";
import { apiErrorResponse } from "../../../../../lib/server/http-errors";
import { buildSpotifyAuthUrl } from "../../../../../lib/server/spotify";

export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => {
    const unauthorized = await requireAdmin(request);

    if (unauthorized) {
      return unauthorized;
    }

    try {
      const state = await signState({
        iat: Date.now(),
        nonce: crypto.randomUUID(),
        purpose: "spotify-auth",
      });
      const authUrl = await buildSpotifyAuthUrl(state);

      return Response.json({
        authUrl,
        ok: true,
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/spotify/auth/start")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
