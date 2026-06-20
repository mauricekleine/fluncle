import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../../-alias";
import { serverHandlers } from "../../../admin/youtube/token";

export const Route = createFileRoute("/api/v1/admin/youtube/token")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
