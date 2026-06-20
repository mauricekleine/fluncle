import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../admin/logout";

export const Route = createFileRoute("/api/v1/admin/logout")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
