import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { jsonError, verifyState } from "../../../../../lib/server/env";
import { logEvent } from "../../../../../lib/server/log";
import {
  exchangeCodeForMixcloudToken,
  mixcloudRedirectUri,
} from "../../../../../lib/server/mixcloud";
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
      return jsonError(400, "mixcloud_auth_failed", `Mixcloud authorization failed: ${error}`);
    }

    if (!code || !state) {
      return jsonError(400, "invalid_request", "Missing Mixcloud code or state");
    }

    try {
      const statePayload = await verifyState(state);

      if (statePayload.purpose !== "mixcloud-auth") {
        return jsonError(400, "invalid_state", "Invalid state");
      }

      if (!stateIsBoundToThisBrowser(request, statePayload)) {
        return jsonError(400, "invalid_state", "Invalid state");
      }

      await exchangeCodeForMixcloudToken(code, mixcloudRedirectUri(url.origin));

      return new Response(null, {
        headers: {
          Location: "/admin?mixcloud=connected",
          "Set-Cookie": clearedStateCookie("mixcloud-auth"),
        },
        status: 302,
      });
    } catch (authError) {
      logEvent("error", "mixcloud.auth-callback-failed", { error: authError });
      return jsonError(
        400,
        "mixcloud_auth_failed",
        "Mixcloud authorization failed — retry from the board.",
      );
    }
  },
};

export const Route = createFileRoute("/api/admin/mixcloud/auth/callback")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
