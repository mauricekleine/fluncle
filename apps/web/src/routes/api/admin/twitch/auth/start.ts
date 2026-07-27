import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { requireOperator } from "../../../../../lib/server/env";
import { startOauthConnect } from "../../../../../lib/server/oauth-handoff";

// Admin-gated start of our own Twitch OAuth (the /reach follower total). Mirrors the
// Mixcloud/YouTube start route; the callback verifies the same signed state. The token
// is provisioned + stored server-side — the CLI never holds the durable credential.
// Twitch is a stats source, not an admin identity provider (login stays Spotify-only).
// Unconfigured (no client id/secret) answers a clean 400, never a crash. The carrier
// branch lives in `startOauthConnect` (lib/server/oauth-handoff.ts): a browser gets
// the provider URL + its nonce cookie, a Bearer caller gets a Fluncle-origin handoff
// link that mints the state in the operator's browser.
export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    return startOauthConnect(request, "twitch-auth");
  },
};

export const Route = createFileRoute("/api/admin/twitch/auth/start")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
