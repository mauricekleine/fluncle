import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../-alias";
import { serverHandlers } from "../search";

export const Route = createFileRoute("/api/v1/search")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
