import { createFileRoute } from "@tanstack/react-router";
import { requireAdmin } from "../../../lib/server/env";
import { apiErrorResponse } from "../../../lib/server/http-errors";
import { addTracksToMixtape, setMixtapeMembers } from "../../../lib/server/mixtapes";

export const Route = createFileRoute("/api/admin/mixtapes/$mixtapeId/members")({
  server: {
    handlers: {
      // PUT replaces the whole tracklist (the editor's drag-reorder); POST appends
      // to it (the board's "Add to mixtape"). Both are draft-only, server-enforced.
      POST: async ({ params, request }) => {
        const unauthorized = await requireAdmin(request);

        if (unauthorized) {
          return unauthorized;
        }

        try {
          const mixtape = await addTracksToMixtape(params.mixtapeId, await request.json());

          return Response.json({ mixtape, ok: true });
        } catch (error) {
          return apiErrorResponse(error);
        }
      },
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
