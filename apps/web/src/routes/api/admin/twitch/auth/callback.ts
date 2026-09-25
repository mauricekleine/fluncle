import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { jsonError, verifyState } from "../../../../../lib/server/env";
import { logEvent } from "../../../../../lib/server/log";
import {
  clearedStateCookie,
  stateIsBoundToThisBrowser,
} from "../../../../../lib/server/oauth-state";
import { exchangeCodeForTwitchToken, twitchRedirectUri } from "../../../../../lib/server/twitch";

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

      if (!stateIsBoundToThisBrowser(request, statePayload)) {
        return jsonError(400, "invalid_state", "Invalid state");
      }

      await exchangeCodeForTwitchToken(code, twitchRedirectUri(url.origin));

      return new Response(null, {
        headers: {
          Location: "/admin?twitch=connected",
          "Set-Cookie": clearedStateCookie("twitch-auth"),
        },
        status: 302,
      });
    } catch (authError) {
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
