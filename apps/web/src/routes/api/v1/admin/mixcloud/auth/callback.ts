import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../../../-alias";
import { serverHandlers } from "../../../../admin/mixcloud/auth/callback";

export const Route = createFileRoute("/api/v1/admin/mixcloud/auth/callback")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
