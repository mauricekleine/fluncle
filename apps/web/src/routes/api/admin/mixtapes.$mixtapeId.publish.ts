import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";
import { requireOperator } from "../../../lib/server/env";
import { apiErrorResponse, requireParam } from "../../../lib/server/http-errors";
import { publishMixtape } from "../../../lib/server/mixtapes";

export const serverHandlers: ApiHandlers = {
  POST: async ({ params, request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    try {
      const mixtape = await publishMixtape(requireParam(params.mixtapeId, "mixtapeId"));

      return Response.json({ mixtape, ok: true });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/mixtapes/$mixtapeId/publish")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
