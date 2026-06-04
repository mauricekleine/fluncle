import { createFileRoute } from "@tanstack/react-router";
import { jsonError } from "../../lib/server/env";
import { createSubmission, type SubmissionInput } from "../../lib/server/submissions";
import { ApiError } from "../../lib/server/spotify";

export const Route = createFileRoute("/api/submissions")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as SubmissionInput;
          const submission = await createSubmission(body, request);

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
