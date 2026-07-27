import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../../../-alias";
import { serverHandlers } from "../../../../admin/instagram/auth/start";

export const Route = createFileRoute("/api/v1/admin/instagram/auth/start")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
