import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../../../-alias";
import { serverHandlers } from "../../../../admin/twitch/auth/start";

export const Route = createFileRoute("/api/v1/admin/twitch/auth/start")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
