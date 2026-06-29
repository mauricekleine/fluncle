import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";
import { listClips } from "../../../lib/server/clips";
import { requireAdmin } from "../../../lib/server/env";
import { apiErrorResponse } from "../../../lib/server/http-errors";

export const serverHandlers: ApiHandlers = {
  // GET /admin/clips — admin tier (agent-allowed). Optional ?mixtapeId/?status filters;
  // serves both the per-set editor and the cross-set clip library (Unit D/E/G).
  GET: async ({ request }) => {
    const unauthorized = await requireAdmin(request);

    if (unauthorized) {
      return unauthorized;
    }

    try {
      const url = new URL(request.url);
      const mixtapeId = url.searchParams.get("mixtapeId") ?? undefined;
      const status = url.searchParams.get("status") ?? undefined;

      return Response.json({ clips: await listClips({ mixtapeId, status }), ok: true });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/clips")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
