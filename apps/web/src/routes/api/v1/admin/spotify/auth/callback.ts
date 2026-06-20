import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../../../-alias";
import { serverHandlers } from "../../../../admin/spotify/auth/callback";

export const Route = createFileRoute("/api/v1/admin/spotify/auth/callback")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
