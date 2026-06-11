import { createFileRoute } from "@tanstack/react-router";
import { clearedGrantCookie } from "../../../lib/server/admin-auth";

// Expire the admin grant cookie and bounce to the login page. Public: clearing a
// cookie nobody holds is harmless, and it keeps the sign-out link dumb.
export const Route = createFileRoute("/api/admin/logout")({
  server: {
    handlers: {
      GET: async () =>
        new Response(null, {
          headers: { Location: "/admin/login", "Set-Cookie": clearedGrantCookie() },
          status: 302,
        }),
    },
  },
});
