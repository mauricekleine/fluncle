import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../-alias";
import { serverHandlers } from "../stories";

export const Route = createFileRoute("/api/v1/stories")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
