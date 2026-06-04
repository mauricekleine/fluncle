import { createFileRoute } from "@tanstack/react-router";
import { jsonError, requireAdmin, signState } from "../../../../../lib/server/env";
import { buildSpotifyAuthUrl } from "../../../../../lib/server/spotify";

export const Route = createFileRoute("/api/admin/spotify/auth/start")({
  server: {
    handlers: {
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
          return jsonError(500, "error", error instanceof Error ? error.message : String(error));
        }
      },
    },
  },
});
