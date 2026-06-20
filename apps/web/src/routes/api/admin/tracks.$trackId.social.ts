import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";

import { requireAdmin } from "../../../lib/server/env";
import { apiErrorResponse, trackNotFoundResponse } from "../../../lib/server/http-errors";
import { listSocialPosts } from "../../../lib/server/social";
import { getTrackByIdOrLogId } from "../../../lib/server/tracks";

// GET /api/admin/tracks/:idOrLogId/social — the track's per-platform publication
// state (one entry per platform).
export const serverHandlers: ApiHandlers = {
  GET: async ({ params, request }) => {
    const unauthorized = await requireAdmin(request);

    if (unauthorized) {
      return unauthorized;
    }

    const idOrLogId = params.trackId;

    try {
      const track = await getTrackByIdOrLogId(idOrLogId);

      if (!track) {
        return trackNotFoundResponse(idOrLogId);
      }

      const posts = await listSocialPosts(track.trackId);

      return Response.json({ ok: true, posts, trackId: track.trackId });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/tracks/$trackId/social")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
