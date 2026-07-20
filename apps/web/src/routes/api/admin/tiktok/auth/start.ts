import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { requireOperator, signState } from "../../../../../lib/server/env";
import { apiErrorResponse } from "../../../../../lib/server/http-errors";
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
      const state = await signState({
        iat: Date.now(),
        nonce: crypto.randomUUID(),
        purpose: "tiktok-auth",
      });
      const authUrl = await buildTikTokAuthUrl(state);

      return Response.json({
        authUrl,
        ok: true,
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/tiktok/auth/start")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
