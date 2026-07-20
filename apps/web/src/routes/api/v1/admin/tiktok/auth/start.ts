import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../../../-alias";
import { serverHandlers } from "../../../../admin/tiktok/auth/start";

export const Route = createFileRoute("/api/v1/admin/tiktok/auth/start")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
