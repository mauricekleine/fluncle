import { createFileRoute } from "@tanstack/react-router";
import { jsonError } from "../../lib/server/env";
import { subscribeToNewsletter, type NewsletterInput } from "../../lib/server/newsletter";
import { ApiError } from "../../lib/server/spotify";

export const Route = createFileRoute("/api/newsletter")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as NewsletterInput;
          await subscribeToNewsletter(body, request);

          return Response.json({ ok: true });
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
