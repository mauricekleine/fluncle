import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../../../-alias";
import { serverHandlers } from "../../../../admin/youtube/auth/start";

export const Route = createFileRoute("/api/v1/admin/youtube/auth/start")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
