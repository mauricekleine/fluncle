import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { apiErrorResponse } from "../../../../../lib/server/http-errors";
import { readHandoffTicket } from "../../../../../lib/server/oauth-handoff";
import { mintOauthState } from "../../../../../lib/server/oauth-state";
import { buildSpotifyLoginUrl } from "../../../../../lib/server/spotify";

export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => {
    try {
      const ticket = new URL(request.url).searchParams.get("handoff");
      const carried: Record<string, string> =
        ticket && (await readHandoffTicket(ticket)) ? { handoff: ticket } : {};

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
