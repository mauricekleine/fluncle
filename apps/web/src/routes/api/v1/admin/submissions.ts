import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../admin/submissions";

export const Route = createFileRoute("/api/v1/admin/submissions")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
