import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "./-alias";
import { listMixtapes } from "../../lib/server/mixtapes";

export const serverHandlers: ApiHandlers = {
  GET: async () => Response.json({ mixtapes: await listMixtapes(), ok: true }),
};

export const Route = createFileRoute("/api/mixtapes")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
