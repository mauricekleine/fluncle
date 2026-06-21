import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { requireOperator } from "../../../../../lib/server/env";
import { apiErrorResponse } from "../../../../../lib/server/http-errors";
import { lastfmGetToken } from "../../../../../lib/server/lastfm";

// Step 1 of the Last.fm desktop auth flow: auth.getToken → an unauthorized request
// token + the authorize URL Maurice opens to approve it (logged in as `fluncle`).
// Unlike the Spotify/YouTube/Mixcloud OAuth, Last.fm has no provider→callback
// redirect: after approving, the CLI calls /api/admin/lastfm/auth/session with the
// same token to mint the session key. The session key is a Worker secret
// (LASTFM_SESSION_KEY), not a DB row — no schema change.
export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    try {
      const { authUrl, token } = await lastfmGetToken();

      return Response.json({ authUrl, ok: true, token });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/lastfm/auth/start")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
