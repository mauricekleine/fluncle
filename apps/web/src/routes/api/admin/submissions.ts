import { createFileRoute } from "@tanstack/react-router";
import { jsonError, requireAdmin } from "../../../lib/server/env";
import { listPendingSubmissions } from "../../../lib/server/submissions";

export const Route = createFileRoute("/api/admin/submissions")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const unauthorized = await requireAdmin(request);

        if (unauthorized) {
          return unauthorized;
        }

        try {
          const submissions = await listPendingSubmissions();

          return Response.json({
            ok: true,
            submissions,
          });
        } catch (error) {
          return jsonError(500, "error", error instanceof Error ? error.message : String(error));
        }
      },
    },
  },
});
