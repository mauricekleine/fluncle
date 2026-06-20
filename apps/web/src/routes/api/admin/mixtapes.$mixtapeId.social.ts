import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";
import { requireAdmin } from "../../../lib/server/env";
import { apiErrorResponse } from "../../../lib/server/http-errors";
import { listMixtapeSocialPosts } from "../../../lib/server/mixtape-social";

// The per-platform distribution rows for a mixtape (mixtape_social_posts). The
// admin dashboard reads this to show YouTube/Mixcloud upload state; the CLI's
// distribute flow records into it via the platform finalize routes.
export const serverHandlers: ApiHandlers = {
  GET: async ({ params, request }) => {
    const unauthorized = await requireAdmin(request);

    if (unauthorized) {
      return unauthorized;
    }

    try {
      const posts = await listMixtapeSocialPosts(params.mixtapeId);

      return Response.json({ mixtapeId: params.mixtapeId, ok: true, posts });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/mixtapes/$mixtapeId/social")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
