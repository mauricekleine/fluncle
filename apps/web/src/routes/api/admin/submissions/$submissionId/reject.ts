import { createFileRoute } from "@tanstack/react-router";
import { jsonError, requireAdmin } from "../../../../../lib/server/env";
import { rejectSubmission } from "../../../../../lib/server/submissions";
import { ApiError } from "../../../../../lib/server/spotify";

export const Route = createFileRoute("/api/admin/submissions/$submissionId/reject")({
  server: {
    handlers: {
      POST: async ({ params, request }) => {
        const unauthorized = await requireAdmin(request);

        if (unauthorized) {
          return unauthorized;
        }

        try {
          const submission = await rejectSubmission(params.submissionId);

          return Response.json({
            ok: true,
            submission,
          });
        } catch (error) {
          if (error instanceof ApiError) {
            return jsonError(error.status, error.code, error.message);
          }

          return jsonError(500, "error", error instanceof Error ? error.message : String(error));
        }
      },
    },
  },
});
