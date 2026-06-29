import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";
import { deleteClip, updateClip } from "../../../lib/server/clips";
import { requireOperator } from "../../../lib/server/env";
import { apiErrorResponse, requireParam } from "../../../lib/server/http-errors";

export const serverHandlers: ApiHandlers = {
  DELETE: async ({ params, request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    try {
      await deleteClip(requireParam(params.clipId, "clipId"));

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
      const clip = await updateClip(requireParam(params.clipId, "clipId"), await request.json());

      return Response.json({ clip, ok: true });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/clips/$clipId")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
