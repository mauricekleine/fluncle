import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../../../-alias";
import { serverHandlers } from "../../../../admin/spotify/auth/login";

export const Route = createFileRoute("/api/v1/admin/spotify/auth/login")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
