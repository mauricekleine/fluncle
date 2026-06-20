import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../../../-alias";
import { serverHandlers } from "../../../../admin/spotify/auth/start";

export const Route = createFileRoute("/api/v1/admin/spotify/auth/start")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
