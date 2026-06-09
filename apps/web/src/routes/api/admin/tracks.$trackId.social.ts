import { createFileRoute } from "@tanstack/react-router";

import { jsonError, requireAdmin } from "../../../lib/server/env";
import { listSocialPosts } from "../../../lib/server/social";
import { getTrackByIdOrLogId } from "../../../lib/server/tracks";

// GET /api/admin/tracks/:idOrLogId/social — the track's per-platform publication
// state (one entry per platform).
export const Route = createFileRoute("/api/admin/tracks/$trackId/social")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const unauthorized = await requireAdmin(request);

        if (unauthorized) {
          return unauthorized;
        }

        // .../tracks/<idOrLogId>/social
        const parts = new URL(request.url).pathname.split("/").filter(Boolean);
        const idOrLogId = parts[parts.length - 2] ?? "";

        try {
          const track = await getTrackByIdOrLogId(idOrLogId);

          if (!track) {
            return jsonError(404, "not_found", `No track with id ${idOrLogId}`);
          }

          const posts = await listSocialPosts(track.trackId);

          return Response.json({ ok: true, posts, trackId: track.trackId });
        } catch (error) {
          return jsonError(500, "error", error instanceof Error ? error.message : String(error));
        }
      },
    },
  },
});
