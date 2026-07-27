import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../../../-alias";
import { serverHandlers } from "../../../../admin/instagram/auth/callback";

export const Route = createFileRoute("/api/v1/admin/instagram/auth/callback")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
