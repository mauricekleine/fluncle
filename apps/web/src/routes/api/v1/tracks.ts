import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../-alias";
import { serverHandlers } from "../tracks";

export const Route = createFileRoute("/api/v1/tracks")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
