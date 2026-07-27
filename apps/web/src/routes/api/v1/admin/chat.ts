import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../admin/chat";

export const Route = createFileRoute("/api/v1/admin/chat")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
