import { createFileRoute } from "@tanstack/react-router";
import { createCsrfToken, requirePublicUser } from "../../../lib/server/public-auth";

export const Route = createFileRoute("/api/me/csrf")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const user = await requirePublicUser(request);

        return user instanceof Response
          ? user
          : Response.json({ csrfToken: createCsrfToken(user), ok: true });
      },
    },
  },
});
