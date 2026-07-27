import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../../-alias";
import { serverHandlers } from "../../../admin/oauth/handoff";

export const Route = createFileRoute("/api/v1/admin/oauth/handoff")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
