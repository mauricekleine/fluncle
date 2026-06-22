import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";
import { createMixtape, listMixtapes } from "../../../lib/server/mixtapes";
import { requireAdmin, requireOperator } from "../../../lib/server/env";
import { apiErrorResponse } from "../../../lib/server/http-errors";

export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => {
    const unauthorized = await requireAdmin(request);

    if (unauthorized) {
      return unauthorized;
    }

    return Response.json({
      mixtapes: await listMixtapes({ hydrateMembers: true, includeDrafts: true }),
      ok: true,
    });
  },
  POST: async ({ request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    try {
      return Response.json({ mixtape: await createMixtape(await request.json()), ok: true });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/mixtapes")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
