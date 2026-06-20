import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../me/galaxy-progress";

export const Route = createFileRoute("/api/v1/me/galaxy-progress")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
