import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { requireOperator } from "../../../../../lib/server/env";
import { startOauthConnect } from "../../../../../lib/server/oauth-handoff";

// Admin-gated start of our own Instagram OAuth (the /reach follower count), via the
// "Instagram API with Instagram Login" business flow. Mirrors the Mixcloud/YouTube
// start route; the callback verifies the same signed state. The token is provisioned +
// stored server-side — the CLI never holds the durable credential. Instagram is a stats
// source, not an admin identity provider (login stays Spotify-only). Unconfigured (no
// client id/secret) answers a clean 400, never a crash. The carrier branch lives in
// `startOauthConnect` (lib/server/oauth-handoff.ts): a browser gets the provider URL +
// its nonce cookie, a Bearer caller gets a Fluncle-origin handoff link that mints the
// state in the operator's browser.
export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    return startOauthConnect(request, "instagram-auth");
  },
};

export const Route = createFileRoute("/api/admin/instagram/auth/start")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
