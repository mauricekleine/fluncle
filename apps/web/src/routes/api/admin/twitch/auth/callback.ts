import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { jsonError, verifyState } from "../../../../../lib/server/env";
import { logEvent } from "../../../../../lib/server/log";
import { exchangeCodeForTwitchToken, twitchRedirectUri } from "../../../../../lib/server/twitch";

// Twitch redirects here after the consent screen. We verify the signed state (purpose
// twitch-auth), exchange the code for tokens, store the refresh token in twitch_auth,
// and bounce back to the board. There is no login branch: Twitch is a stats source, not
// an admin identity provider (that stays Spotify-only).
export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => {
    const url = new URL(request.url);
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (error) {
      return jsonError(400, "twitch_auth_failed", `Twitch authorization failed: ${error}`);
    }

    if (!code || !state) {
      return jsonError(400, "invalid_request", "Missing Twitch code or state");
    }

    try {
      const statePayload = await verifyState(state);

      if (statePayload.purpose !== "twitch-auth") {
        return jsonError(400, "invalid_state", "Invalid state");
      }

      await exchangeCodeForTwitchToken(code, twitchRedirectUri(url.origin));

      return new Response(null, {
        headers: { Location: "/admin?twitch=connected" },
        status: 302,
      });
    } catch (authError) {
      // Raw token-exchange detail goes to the server log, not the wire to this
      // unauthenticated callback; keep the code the board keys on, answer plainly.
      logEvent("error", "twitch.auth-callback-failed", { error: authError });
      return jsonError(
        400,
        "twitch_auth_failed",
        "Twitch authorization failed — retry from the board.",
      );
    }
  },
};

export const Route = createFileRoute("/api/admin/twitch/auth/callback")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
