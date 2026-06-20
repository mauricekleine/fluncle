import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";
import { requireAdmin } from "../../../lib/server/env";
import { apiErrorResponse } from "../../../lib/server/http-errors";
import { publishMixtape } from "../../../lib/server/mixtapes";

export const serverHandlers: ApiHandlers = {
  POST: async ({ params, request }) => {
    const unauthorized = await requireAdmin(request);

    if (unauthorized) {
      return unauthorized;
    }

    try {
      const mixtape = await publishMixtape(params.mixtapeId);

      return Response.json({ mixtape, ok: true });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/mixtapes/$mixtapeId/publish")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
