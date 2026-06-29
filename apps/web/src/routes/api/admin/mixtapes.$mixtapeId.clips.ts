import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";
import { createClip } from "../../../lib/server/clips";
import { requireOperator } from "../../../lib/server/env";
import { apiErrorResponse, requireParam } from "../../../lib/server/http-errors";

export const serverHandlers: ApiHandlers = {
  // POST appends one clip to a mixtape (the editor queues a cut). Operator-only.
  POST: async ({ params, request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    try {
      const clip = await createClip(
        requireParam(params.mixtapeId, "mixtapeId"),
        await request.json(),
      );

      return Response.json({ clip, ok: true });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/mixtapes/$mixtapeId/clips")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
