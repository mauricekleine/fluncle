import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";
import { requireOperator } from "../../../lib/server/env";
import { apiErrorResponse, requireParam } from "../../../lib/server/http-errors";
import { deleteMixtape, updateMixtape } from "../../../lib/server/mixtapes";

export const serverHandlers: ApiHandlers = {
  DELETE: async ({ params, request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    try {
      await deleteMixtape(requireParam(params.mixtapeId, "mixtapeId"));

      return Response.json({ ok: true });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
  PATCH: async ({ params, request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    try {
      const mixtape = await updateMixtape(
        requireParam(params.mixtapeId, "mixtapeId"),
        await request.json(),
      );

      return Response.json({ mixtape, ok: true });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/mixtapes/$mixtapeId")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
