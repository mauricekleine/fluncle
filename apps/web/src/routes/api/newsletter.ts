import { createFileRoute } from "@tanstack/react-router";
import { apiErrorResponse } from "../../lib/server/http-errors";
import { subscribeToNewsletter, type NewsletterInput } from "../../lib/server/newsletter";

export const Route = createFileRoute("/api/newsletter")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as NewsletterInput;
          await subscribeToNewsletter(body, request);

          return Response.json({ ok: true });
        } catch (error) {
          return apiErrorResponse(error);
        }
      },
    },
  },
});
