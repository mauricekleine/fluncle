import { createFileRoute } from "@tanstack/react-router";

import { apiErrorResponse, trackNotFoundResponse } from "../../lib/server/http-errors";
import { resolveLogPageTarget } from "../../lib/server/log-resolver";

// Public read of a single finding by its Spotify trackId OR its Log ID — the
// lookup the enrichment agent uses to turn its input into track metadata.
export const Route = createFileRoute("/api/tracks/$idOrLogId")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const idOrLogId = params.idOrLogId;

        try {
          const target = await resolveLogPageTarget(idOrLogId);

          if (!target) {
            return trackNotFoundResponse(idOrLogId);
          }

          return Response.json(
            target.kind === "mixtape"
              ? { mixtape: target.mixtape, ok: true }
              : { ok: true, track: target.track },
          );
        } catch (error) {
          return apiErrorResponse(error);
        }
      },
    },
  },
});
