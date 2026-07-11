import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { grantCookie, isAllowedSpotifyUser, signGrant } from "../../../../../lib/server/admin-auth";
import { jsonError, verifyState } from "../../../../../lib/server/env";
import { logEvent } from "../../../../../lib/server/log";
import { exchangeCodeForToken, fetchSpotifyProfile } from "../../../../../lib/server/spotify";

export const serverHandlers: ApiHandlers = {
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
      // The raw token-exchange detail belongs in the server log, not on the wire
      // to this unauthenticated callback; the board keys its reconnect banner on
      // the code, so keep that and answer with plain operator-facing copy.
      logEvent("error", "spotify.auth-callback-failed", { error: authError });
      return jsonError(
        400,
        "spotify_auth_failed",
        "Spotify authorization failed — retry from the board.",
      );
    }
  },
};

export const Route = createFileRoute("/api/admin/spotify/auth/callback")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
