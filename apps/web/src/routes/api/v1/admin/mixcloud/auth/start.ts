import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../../../-alias";
import { serverHandlers } from "../../../../admin/mixcloud/auth/start";

export const Route = createFileRoute("/api/v1/admin/mixcloud/auth/start")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
