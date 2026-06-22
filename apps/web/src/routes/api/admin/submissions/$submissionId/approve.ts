import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { requireOperator } from "../../../../../lib/server/env";
import { apiErrorResponse, requireParam } from "../../../../../lib/server/http-errors";
import { approveSubmission } from "../../../../../lib/server/submissions";

export const serverHandlers: ApiHandlers = {
  POST: async ({ params, request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    try {
      const submission = await approveSubmission(requireParam(params.submissionId, "submissionId"));

      return Response.json({
        ok: true,
        submission,
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/submissions/$submissionId/approve")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
