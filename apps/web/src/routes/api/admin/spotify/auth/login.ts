import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { apiErrorResponse } from "../../../../../lib/server/http-errors";
import { readHandoffTicket } from "../../../../../lib/server/oauth-handoff";
import { mintOauthState } from "../../../../../lib/server/oauth-state";
import { buildSpotifyLoginUrl } from "../../../../../lib/server/spotify";

// The admin web login front door — PUBLIC by design (this is how you prove who
// you are; the sibling start.ts that requires a Bearer token is the publish-auth
// flow). Redirects to Spotify with identity scopes and a purpose-stamped state;
// the shared callback branches on purpose to verify the account and set the
// grant cookie. Reuses the already-registered redirect URI — no Spotify
// dashboard change needed.
//
// `?handoff=<ticket>` is the CLI round trip (lib/server/oauth-handoff.ts): a connect
// link opened in a browser with no grant cookie bounces here, and the ticket rides
// along INSIDE the signed state so the callback can send the operator back to the
// connect they were trying to run. Only a ticket that verifies is carried; an expired
// or forged one is dropped and the login proceeds normally, landing on /admin. That
// is what keeps this off the open-redirect list — nothing here redirects to a
// caller-supplied URL, only to one fixed path rebuilt from a ticket Fluncle signed.
export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => {
    try {
      const ticket = new URL(request.url).searchParams.get("handoff");
      const carried: Record<string, string> =
        ticket && (await readHandoffTicket(ticket)) ? { handoff: ticket } : {};
      // Always browser-bound: this is the front door a human opens, so the nonce
      // cookie always rides along and the callback requires it back.
      const { setCookie, state } = await mintOauthState("admin-login", carried);
      const authUrl = await buildSpotifyLoginUrl(state);

      return new Response(null, {
        headers: {
          Location: authUrl,
          "Set-Cookie": setCookie,
        },
        status: 302,
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/spotify/auth/login")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
