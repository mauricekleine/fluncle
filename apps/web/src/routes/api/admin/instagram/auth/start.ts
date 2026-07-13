import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { requireOperator, signState } from "../../../../../lib/server/env";
import { buildInstagramAuthUrl, instagramRedirectUri } from "../../../../../lib/server/instagram";
import { apiErrorResponse } from "../../../../../lib/server/http-errors";

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
      const state = await signState({
        iat: Date.now(),
        nonce: crypto.randomUUID(),
        purpose: "instagram-auth",
      });
      const redirectUri = instagramRedirectUri(new URL(request.url).origin);
      const authUrl = await buildInstagramAuthUrl(state, redirectUri);

      return Response.json({ authUrl, ok: true });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/instagram/auth/start")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
