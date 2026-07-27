import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { requireOperator } from "../../../../../lib/server/env";
import { startOauthConnect } from "../../../../../lib/server/oauth-handoff";

// Admin-gated start of our own TikTok OAuth (Display API per-video metrics). Mirrors the
// YouTube start route; the callback verifies the same signed state (purpose tiktok-auth).
// The carrier branch lives in `startOauthConnect` (lib/server/oauth-handoff.ts): a
// browser gets the provider URL + its nonce cookie, a Bearer caller gets a
// Fluncle-origin handoff link that mints the state in the operator's browser.
export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    return startOauthConnect(request, "tiktok-auth");
  },
};

export const Route = createFileRoute("/api/admin/tiktok/auth/start")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
