import { createFileRoute } from "@tanstack/react-router";
import { requireAdmin } from "../../../lib/server/env";
import { apiErrorResponse } from "../../../lib/server/http-errors";
import { updateMixtape } from "../../../lib/server/mixtapes";

export const Route = createFileRoute("/api/admin/mixtapes/$mixtapeId")({
  server: {
    handlers: {
      PATCH: async ({ params, request }) => {
        const unauthorized = await requireAdmin(request);

        if (unauthorized) {
          return unauthorized;
        }

        try {
          const mixtape = await updateMixtape(params.mixtapeId, await request.json());

          return Response.json({ mixtape, ok: true });
        } catch (error) {
          return apiErrorResponse(error);
        }
      },
    },
  },
});
