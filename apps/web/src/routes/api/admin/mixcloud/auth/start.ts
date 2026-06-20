import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { requireAdmin, signState } from "../../../../../lib/server/env";
import { apiErrorResponse } from "../../../../../lib/server/http-errors";
import { buildMixcloudAuthUrl, mixcloudRedirectUri } from "../../../../../lib/server/mixcloud";

// Admin-gated start of our own Mixcloud OAuth (mixtape audio distribution).
// Mirrors the Spotify/YouTube start route; the callback verifies the same signed
// state. The token is provisioned + stored server-side — the CLI never holds the
// durable credential.
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
        purpose: "mixcloud-auth",
      });
      const redirectUri = mixcloudRedirectUri(new URL(request.url).origin);
      const authUrl = await buildMixcloudAuthUrl(state, redirectUri);

      return Response.json({
        authUrl,
        ok: true,
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/mixcloud/auth/start")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
