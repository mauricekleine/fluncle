import { createFileRoute } from "@tanstack/react-router";
import { jsonError, signState } from "../../../../../lib/server/env";
import { buildSpotifyLoginUrl } from "../../../../../lib/server/spotify";

// The admin web login front door — PUBLIC by design (this is how you prove who
// you are; the sibling start.ts that requires a Bearer token is the publish-auth
// flow). Redirects to Spotify with identity scopes and a purpose-stamped state;
// the shared callback branches on purpose to verify the account and set the
// grant cookie. Reuses the already-registered redirect URI — no Spotify
// dashboard change needed.
export const Route = createFileRoute("/api/admin/spotify/auth/login")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const state = await signState({
            iat: Date.now(),
            nonce: crypto.randomUUID(),
            purpose: "admin-login",
          });
          const authUrl = await buildSpotifyLoginUrl(state);

          return new Response(null, {
            headers: { Location: authUrl },
            status: 302,
          });
        } catch (error) {
          return jsonError(500, "error", error instanceof Error ? error.message : String(error));
        }
      },
    },
  },
});
