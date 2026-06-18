import { createFileRoute } from "@tanstack/react-router";
import { grantCookie, isAllowedSpotifyUser, signGrant } from "../../../../../lib/server/admin-auth";
import { jsonError, verifyState } from "../../../../../lib/server/env";
import { exchangeCodeForToken, fetchSpotifyProfile } from "../../../../../lib/server/spotify";

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

          // Admin web login: read the caller's Spotify identity, discard the
          // tokens (never touch the publish refresh token), and — if it's the
          // allow-listed operator — hand the browser the signed grant cookie.
          if (statePayload.purpose === "admin-login") {
            const profile = await fetchSpotifyProfile(code);

            if (!(await isAllowedSpotifyUser(profile))) {
              return new Response(null, {
                headers: { Location: "/admin/login?error=denied" },
                status: 302,
              });
            }

            return new Response(null, {
              headers: { Location: "/admin", "Set-Cookie": grantCookie(await signGrant()) },
              status: 302,
            });
          }

          if (statePayload.purpose !== "spotify-auth") {
            return jsonError(400, "invalid_state", "Invalid state");
          }

          await exchangeCodeForToken(code);

          // Close the loop back to the board's reconnect banner rather than a dead
          // text page — the board re-reads the connection status on focus.
          return new Response(null, {
            headers: { Location: "/admin?spotify=connected" },
            status: 302,
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
