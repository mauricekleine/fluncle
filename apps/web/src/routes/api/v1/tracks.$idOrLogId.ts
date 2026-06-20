import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../-alias";
import { serverHandlers } from "../tracks.$idOrLogId";

export const Route = createFileRoute("/api/v1/tracks/$idOrLogId")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
