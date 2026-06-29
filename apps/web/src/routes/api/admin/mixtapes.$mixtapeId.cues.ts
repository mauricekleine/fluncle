import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";
import { requireOperator } from "../../../lib/server/env";
import { apiErrorResponse, requireParam } from "../../../lib/server/http-errors";
import { setMixtapeCues } from "../../../lib/server/mixtapes";

export const serverHandlers: ApiHandlers = {
  // PUT backfills a minted mixtape's per-track cues (start_ms) — the hardened
  // post-publish write-path. Operator-only; the server helper owns the guards.
  PUT: async ({ params, request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    try {
      const mixtape = await setMixtapeCues(
        requireParam(params.mixtapeId, "mixtapeId"),
        await request.json(),
      );

      return Response.json({ mixtape, ok: true });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/mixtapes/$mixtapeId/cues")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
