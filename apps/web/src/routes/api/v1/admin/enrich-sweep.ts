import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../admin/enrich-sweep";

export const Route = createFileRoute("/api/v1/admin/enrich-sweep")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
