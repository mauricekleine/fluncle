import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../-alias";
import { serverHandlers } from "../me";

export const Route = createFileRoute("/api/v1/me")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
