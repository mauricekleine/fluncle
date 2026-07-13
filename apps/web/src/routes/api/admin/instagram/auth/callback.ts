import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { jsonError, verifyState } from "../../../../../lib/server/env";
import {
  exchangeCodeForInstagramToken,
  instagramRedirectUri,
} from "../../../../../lib/server/instagram";
import { logEvent } from "../../../../../lib/server/log";

// Instagram redirects here after the consent screen. We verify the signed state
// (purpose instagram-auth), exchange the code for a short-lived token, upgrade it to the
// 60-day long-lived token, store THAT in instagram_auth, and bounce back to the board.
// There is no login branch: Instagram is a stats source, not an admin identity provider
// (that stays Spotify-only).
export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => {
    const url = new URL(request.url);
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (error) {
      return jsonError(400, "instagram_auth_failed", `Instagram authorization failed: ${error}`);
    }

    if (!code || !state) {
      return jsonError(400, "invalid_request", "Missing Instagram code or state");
    }

    try {
      const statePayload = await verifyState(state);

      if (statePayload.purpose !== "instagram-auth") {
        return jsonError(400, "invalid_state", "Invalid state");
      }

      await exchangeCodeForInstagramToken(code, instagramRedirectUri(url.origin));

      return new Response(null, {
        headers: { Location: "/admin?instagram=connected" },
        status: 302,
      });
    } catch (authError) {
      // Raw token-exchange detail goes to the server log, not the wire to this
      // unauthenticated callback; keep the code the board keys on, answer plainly.
      logEvent("error", "instagram.auth-callback-failed", { error: authError });
      return jsonError(
        400,
        "instagram_auth_failed",
        "Instagram authorization failed — retry from the board.",
      );
    }
  },
};

export const Route = createFileRoute("/api/admin/instagram/auth/callback")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
