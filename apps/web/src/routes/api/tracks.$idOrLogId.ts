import { createFileRoute } from "@tanstack/react-router";

import { jsonError } from "../../lib/server/env";
import { getTrackByIdOrLogId } from "../../lib/server/tracks";

// Public read of a single finding by its Spotify trackId OR its Log ID — the
// lookup the enrichment agent uses to turn its input into track metadata.
export const Route = createFileRoute("/api/tracks/$idOrLogId")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const idOrLogId = new URL(request.url).pathname.split("/").filter(Boolean).pop() ?? "";

        try {
          const track = await getTrackByIdOrLogId(idOrLogId);

          if (!track) {
            return jsonError(404, "not_found", `No track with id ${idOrLogId}`);
          }

          return Response.json({ ok: true, track });
        } catch (error) {
          return jsonError(500, "error", error instanceof Error ? error.message : String(error));
        }
      },
    },
  },
});
