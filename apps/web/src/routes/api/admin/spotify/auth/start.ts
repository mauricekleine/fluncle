import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { requireOperator } from "../../../../../lib/server/env";
import { startOauthConnect } from "../../../../../lib/server/oauth-handoff";

// The PUBLISH-auth start; the sibling login.ts is the identity front door. The
// carrier branch lives in `startOauthConnect` (lib/server/oauth-handoff.ts): a
// browser gets the provider URL + its nonce cookie, a Bearer caller gets a
// Fluncle-origin handoff link that mints the state in the operator's browser.
export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    return startOauthConnect(request, "spotify-auth");
  },
};

export const Route = createFileRoute("/api/admin/spotify/auth/start")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
