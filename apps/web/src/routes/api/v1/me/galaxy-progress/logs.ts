import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../../-alias";
import { serverHandlers } from "../../../me/galaxy-progress/logs";

export const Route = createFileRoute("/api/v1/me/galaxy-progress/logs")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
