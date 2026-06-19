import { createFileRoute } from "@tanstack/react-router";
import { jsonError, verifyState } from "../../../../../lib/server/env";
import { exchangeCodeForYouTubeToken } from "../../../../../lib/server/youtube";

// Google redirects here after the consent screen. We verify the signed state
// (purpose youtube-auth), exchange the code for tokens, store the refresh token
// in youtube_auth, and bounce back to the board. There is no login branch:
// YouTube is a distribution sink, not an admin identity provider (that stays
// Spotify-only).
export const Route = createFileRoute("/api/admin/youtube/auth/callback")({
  server: {
    handlers: {
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

          await exchangeCodeForYouTubeToken(code);

          return new Response(null, {
            headers: { Location: "/admin?youtube=connected" },
            status: 302,
          });
        } catch (authError) {
          return jsonError(
            400,
            "youtube_auth_failed",
            authError instanceof Error ? authError.message : String(authError),
          );
        }
      },
    },
  },
});
