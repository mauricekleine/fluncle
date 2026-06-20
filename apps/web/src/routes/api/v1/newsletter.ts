import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../-alias";
import { serverHandlers } from "../newsletter";

export const Route = createFileRoute("/api/v1/newsletter")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
