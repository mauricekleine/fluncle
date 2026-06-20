import { createFileRoute } from "@tanstack/react-router";
import { requireAdmin } from "../../../lib/server/env";
import { apiErrorResponse } from "../../../lib/server/http-errors";
import { setMixtapeMembers } from "../../../lib/server/mixtapes";

export const Route = createFileRoute("/api/admin/mixtapes/$mixtapeId/members")({
  server: {
    handlers: {
      PUT: async ({ params, request }) => {
        const unauthorized = await requireAdmin(request);

        if (unauthorized) {
          return unauthorized;
        }

        try {
          const mixtape = await setMixtapeMembers(params.mixtapeId, await request.json());

          return Response.json({ mixtape, ok: true });
        } catch (error) {
          return apiErrorResponse(error);
        }
      },
    },
  },
});

export const serverHandlers = Route.options.server!.handlers;
