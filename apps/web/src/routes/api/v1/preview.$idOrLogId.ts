import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../-alias";
import { serverHandlers } from "../preview.$idOrLogId";

export const Route = createFileRoute("/api/v1/preview/$idOrLogId")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
