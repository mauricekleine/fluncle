import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../admin/tracks";

export const Route = createFileRoute("/api/v1/admin/tracks")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
