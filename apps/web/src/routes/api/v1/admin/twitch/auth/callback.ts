import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../../../-alias";
import { serverHandlers } from "../../../../admin/twitch/auth/callback";

export const Route = createFileRoute("/api/v1/admin/twitch/auth/callback")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
