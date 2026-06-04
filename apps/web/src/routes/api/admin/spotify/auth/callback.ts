import { createFileRoute } from "@tanstack/react-router";
import { jsonError, verifyState } from "../../../../../lib/server/env";
import { exchangeCodeForToken } from "../../../../../lib/server/spotify";

export const Route = createFileRoute("/api/admin/spotify/auth/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");

        if (error) {
          return jsonError(400, "spotify_auth_failed", `Spotify authorization failed: ${error}`);
        }

        if (!code || !state) {
          return jsonError(400, "invalid_request", "Missing Spotify code or state");
        }

        try {
          const statePayload = await verifyState(state);

          if (statePayload.purpose !== "spotify-auth") {
            return jsonError(400, "invalid_state", "Invalid state");
          }

          await exchangeCodeForToken(code);

          return new Response("Spotify auth stored in Turso.", {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
            },
          });
        } catch (authError) {
          return jsonError(
            400,
            "spotify_auth_failed",
            authError instanceof Error ? authError.message : String(authError),
          );
        }
      },
    },
  },
});
