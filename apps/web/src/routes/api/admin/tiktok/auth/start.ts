import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { requireOperator, signState } from "../../../../../lib/server/env";
import { apiErrorResponse } from "../../../../../lib/server/http-errors";
import { buildTiktokAuthUrl, tiktokRedirectUri } from "../../../../../lib/server/tiktok";

// Admin-gated start of our own TikTok OAuth (the /reach follower + likes totals).
// Mirrors the Mixcloud/YouTube start route; the callback verifies the same signed
// state. The token is provisioned + stored server-side — the CLI never holds the
// durable credential. TikTok is a stats source, not an admin identity provider (login
// stays Spotify-only). Unconfigured (no client key/secret) answers a clean 400.
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
        purpose: "tiktok-auth",
      });
      const redirectUri = tiktokRedirectUri(new URL(request.url).origin);
      const authUrl = await buildTiktokAuthUrl(state, redirectUri);

      return Response.json({ authUrl, ok: true });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/tiktok/auth/start")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
