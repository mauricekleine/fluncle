import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../-alias";
import { requireAdmin } from "../../../../lib/server/env";
import { apiErrorResponse } from "../../../../lib/server/http-errors";
import { getYouTubeAccessToken } from "../../../../lib/server/youtube";

// A fresh short-lived access token WITHOUT opening a new resumable session. The
// CLI calls this when a multi-GB upload outlives its token (a 401 mid-PUT): the
// resumable session URI stays valid for days, so only the token needs refreshing —
// re-initiating would discard the already-uploaded bytes and restart from zero.
export const serverHandlers: ApiHandlers = {
  POST: async ({ request }) => {
    const unauthorized = await requireAdmin(request);

    if (unauthorized) {
      return unauthorized;
    }

    try {
      const accessToken = await getYouTubeAccessToken();

      return Response.json({ accessToken, ok: true });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/youtube/token")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
