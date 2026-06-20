import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../admin/mixtapes";

export const Route = createFileRoute("/api/v1/admin/mixtapes")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
