import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { jsonError, verifyState } from "../../../../../lib/server/env";
import { logEvent } from "../../../../../lib/server/log";
import {
  clearedStateCookie,
  stateIsBoundToThisBrowser,
} from "../../../../../lib/server/oauth-state";
import { exchangeCodeForYouTubeToken } from "../../../../../lib/server/youtube";

export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => {
    const url = new URL(request.url);
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (error) {
      return jsonError(400, "youtube_auth_failed", `YouTube authorization failed: ${error}`);
    }

    if (!code || !state) {
      return jsonError(400, "invalid_request", "Missing YouTube code or state");
    }

    try {
      const statePayload = await verifyState(state);

      if (statePayload.purpose !== "youtube-auth") {
        return jsonError(400, "invalid_state", "Invalid state");
      }

      if (!stateIsBoundToThisBrowser(request, statePayload)) {
        return jsonError(400, "invalid_state", "Invalid state");
      }

      await exchangeCodeForYouTubeToken(code);

      return new Response(null, {
        headers: {
          Location: "/admin?youtube=connected",
          "Set-Cookie": clearedStateCookie("youtube-auth"),
        },
        status: 302,
      });
    } catch (authError) {
      logEvent("error", "youtube.auth-callback-failed", { error: authError });
      return jsonError(
        400,
        "youtube_auth_failed",
        "YouTube authorization failed — retry from the board.",
      );
    }
  },
};

export const Route = createFileRoute("/api/admin/youtube/auth/callback")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
