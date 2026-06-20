import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../../../-alias";
import { serverHandlers } from "../../../../admin/lastfm/auth/session";

export const Route = createFileRoute("/api/v1/admin/lastfm/auth/session")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
