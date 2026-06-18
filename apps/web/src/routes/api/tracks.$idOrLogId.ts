import { createFileRoute } from "@tanstack/react-router";

import { jsonError } from "../../lib/server/env";
import { resolveLogPageTarget } from "../../lib/server/log-resolver";

// Public read of a single finding by its Spotify trackId OR its Log ID — the
// lookup the enrichment agent uses to turn its input into track metadata.
export const Route = createFileRoute("/api/tracks/$idOrLogId")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const idOrLogId = new URL(request.url).pathname.split("/").filter(Boolean).pop() ?? "";

        try {
          const target = await resolveLogPageTarget(idOrLogId);

          if (!target) {
            return jsonError(404, "not_found", `No track with id ${idOrLogId}`);
          }

          return Response.json(
            target.kind === "mixtape"
              ? { mixtape: target.mixtape, ok: true }
              : { ok: true, track: target.track },
          );
        } catch (error) {
          return jsonError(500, "error", error instanceof Error ? error.message : String(error));
        }
      },
    },
  },
});
