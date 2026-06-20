import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";
import { createCsrfToken, requirePublicUser } from "../../../lib/server/public-auth";

export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => {
    const user = await requirePublicUser(request);

    return user instanceof Response
      ? user
      : Response.json({ csrfToken: createCsrfToken(user), ok: true });
  },
};

export const Route = createFileRoute("/api/me/csrf")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
