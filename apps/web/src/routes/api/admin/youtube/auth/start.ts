import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { requireOperator } from "../../../../../lib/server/env";
import { startOauthConnect } from "../../../../../lib/server/oauth-handoff";

// Admin-gated start of our own YouTube OAuth (mixtape video distribution).
// Mirrors the Spotify start route; the callback verifies the same signed state.
// The carrier branch lives in `startOauthConnect` (lib/server/oauth-handoff.ts): a
// browser gets the provider URL + its nonce cookie, a Bearer caller gets a
// Fluncle-origin handoff link that mints the state in the operator's browser.
export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    return startOauthConnect(request, "youtube-auth");
  },
};

export const Route = createFileRoute("/api/admin/youtube/auth/start")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
