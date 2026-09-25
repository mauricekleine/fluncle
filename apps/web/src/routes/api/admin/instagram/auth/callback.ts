import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { jsonError, verifyState } from "../../../../../lib/server/env";
import {
  exchangeCodeForInstagramToken,
  instagramRedirectUri,
} from "../../../../../lib/server/instagram";
import { logEvent } from "../../../../../lib/server/log";
import {
  clearedStateCookie,
  stateIsBoundToThisBrowser,
} from "../../../../../lib/server/oauth-state";

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

      if (!stateIsBoundToThisBrowser(request, statePayload)) {
        return jsonError(400, "invalid_state", "Invalid state");
      }

      await exchangeCodeForInstagramToken(code, instagramRedirectUri(url.origin));

      return new Response(null, {
        headers: {
          Location: "/admin?instagram=connected",
          "Set-Cookie": clearedStateCookie("instagram-auth"),
        },
        status: 302,
      });
    } catch (authError) {
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
