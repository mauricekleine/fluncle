import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";
import { clearedGrantCookie } from "../../../lib/server/admin-auth";

// Expire the admin grant cookie and bounce to the login page. Public: clearing a
// cookie nobody holds is harmless, and it keeps the sign-out link dumb.
export const serverHandlers: ApiHandlers = {
  GET: async () =>
    new Response(null, {
      headers: { Location: "/admin/login", "Set-Cookie": clearedGrantCookie() },
      status: 302,
    }),
};

export const Route = createFileRoute("/api/admin/logout")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
