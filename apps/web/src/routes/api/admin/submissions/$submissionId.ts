import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../-alias";
import { requireAdmin } from "../../../../lib/server/env";
import { apiErrorResponse, requireParam } from "../../../../lib/server/http-errors";
import { getSubmission } from "../../../../lib/server/submissions";

export const serverHandlers: ApiHandlers = {
  GET: async ({ params, request }) => {
    const unauthorized = await requireAdmin(request);

    if (unauthorized) {
      return unauthorized;
    }

    try {
      const submission = await getSubmission(requireParam(params.submissionId, "submissionId"));

      return Response.json({
        ok: true,
        submission,
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/submissions/$submissionId")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
