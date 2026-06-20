import { createFileRoute } from "@tanstack/react-router";
import { jsonError, verifyState } from "../../../../../lib/server/env";
import { exchangeCodeForMixcloudToken } from "../../../../../lib/server/mixcloud";

// Mixcloud redirects here after the consent screen. We verify the signed state
// (purpose mixcloud-auth), exchange the code for the access token, store it in
// mixcloud_auth, and bounce back to the board. Mixcloud is a distribution sink,
// not an admin identity provider (login stays Spotify-only).
export const Route = createFileRoute("/api/admin/mixcloud/auth/callback")({
  server: {
    handlers: {
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

          await exchangeCodeForMixcloudToken(code);

          return new Response(null, {
            headers: { Location: "/admin?mixcloud=connected" },
            status: 302,
          });
        } catch (authError) {
          return jsonError(
            400,
            "mixcloud_auth_failed",
            authError instanceof Error ? authError.message : String(authError),
          );
        }
      },
    },
  },
});
