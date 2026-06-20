import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "./-alias";
import { apiErrorResponse } from "../../lib/server/http-errors";
import { createSubmission, type SubmissionInput } from "../../lib/server/submissions";

export const serverHandlers: ApiHandlers = {
  POST: async ({ request }) => {
    try {
      const body = (await request.json()) as SubmissionInput;
      const submission = await createSubmission(body, request);

      return Response.json({
        ok: true,
        submission,
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/submissions")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
