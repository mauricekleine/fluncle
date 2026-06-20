import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../../../-alias";
import { serverHandlers } from "../../../../admin/youtube/auth/callback";

export const Route = createFileRoute("/api/v1/admin/youtube/auth/callback")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
