import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";
import { clearedGrantCookie } from "../../../lib/server/admin-auth";

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
