import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../../../-alias";
import { serverHandlers } from "../../../../admin/lastfm/auth/start";

export const Route = createFileRoute("/api/v1/admin/lastfm/auth/start")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
