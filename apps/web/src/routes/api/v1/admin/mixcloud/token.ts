import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../../-alias";
import { serverHandlers } from "../../../admin/mixcloud/token";

export const Route = createFileRoute("/api/v1/admin/mixcloud/token")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
