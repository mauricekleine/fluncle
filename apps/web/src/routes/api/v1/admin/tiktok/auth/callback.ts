import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../../../-alias";
import { serverHandlers } from "../../../../admin/tiktok/auth/callback";

export const Route = createFileRoute("/api/v1/admin/tiktok/auth/callback")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
