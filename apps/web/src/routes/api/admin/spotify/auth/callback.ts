import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { grantCookie, isAllowedSpotifyUser, signGrant } from "../../../../../lib/server/admin-auth";
import { jsonError, verifyState } from "../../../../../lib/server/env";
import { logEvent } from "../../../../../lib/server/log";
import { handoffUrl } from "../../../../../lib/server/oauth-handoff";
import {
  clearedStateCookie,
  stateIsBoundToThisBrowser,
} from "../../../../../lib/server/oauth-state";
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

      if (!stateIsBoundToThisBrowser(request, statePayload)) {
        return jsonError(400, "invalid_state", "Invalid state");
      }

      if (statePayload.purpose === "admin-login") {
        const profile = await fetchSpotifyProfile(code);

        if (!(await isAllowedSpotifyUser(profile))) {
          return new Response(null, {
            headers: { Location: "/admin/login?error=denied" },
            status: 302,
          });
        }

        const carried = statePayload.handoff;
        const destination =
          typeof carried === "string" && carried ? handoffUrl("", carried) : "/admin";

        const headers = new Headers({ Location: destination });
        headers.append("Set-Cookie", grantCookie(await signGrant()));
        headers.append("Set-Cookie", clearedStateCookie("admin-login"));

        return new Response(null, { headers, status: 302 });
      }

      if (statePayload.purpose !== "spotify-auth") {
        return jsonError(400, "invalid_state", "Invalid state");
      }

      await exchangeCodeForToken(code);

      return new Response(null, {
        headers: {
          Location: "/admin?spotify=connected",
          "Set-Cookie": clearedStateCookie("spotify-auth"),
        },
        status: 302,
      });
    } catch (authError) {
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
