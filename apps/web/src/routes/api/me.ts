import { createFileRoute } from "@tanstack/react-router";
import { meResponse } from "../../lib/server/account-data";
import { type ApiHandlers, aliasHandlers } from "./-alias";

export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => Response.json(await meResponse(request)),
};

export const Route = createFileRoute("/api/me")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
