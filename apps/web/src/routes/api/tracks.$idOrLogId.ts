import { createFileRoute } from "@tanstack/react-router";

import {
  apiErrorResponse,
  requireParam,
  trackNotFoundResponse,
} from "../../lib/server/http-errors";
import { resolveLogPageTarget } from "../../lib/server/log-resolver";
import { type ApiHandlers, aliasHandlers } from "./-alias";

// Public read of a single finding by its Spotify trackId OR its Log ID — the
// lookup the enrichment agent uses to turn its input into track metadata. The
// handlers are shared so the canonical /api/v1 mount and the /api alias serve
// one implementation; see ./-alias for the dual-mount contract.
export const serverHandlers: ApiHandlers = {
  GET: async ({ params }) => {
    const idOrLogId = requireParam(params.idOrLogId, "idOrLogId");

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
};

export const Route = createFileRoute("/api/tracks/$idOrLogId")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
