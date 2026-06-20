import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "./-alias";
import { apiErrorResponse } from "../../lib/server/http-errors";
import { subscribeToNewsletter, type NewsletterInput } from "../../lib/server/newsletter";

export const serverHandlers: ApiHandlers = {
  POST: async ({ request }) => {
    try {
      const body = (await request.json()) as NewsletterInput;
      await subscribeToNewsletter(body, request);

      return Response.json({ ok: true });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/newsletter")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
