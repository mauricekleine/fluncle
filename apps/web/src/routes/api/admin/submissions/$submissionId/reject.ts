import { createFileRoute } from "@tanstack/react-router";
import { requireAdmin } from "../../../../../lib/server/env";
import { apiErrorResponse } from "../../../../../lib/server/http-errors";
import { rejectSubmission } from "../../../../../lib/server/submissions";

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
          return apiErrorResponse(error);
        }
      },
    },
  },
});
