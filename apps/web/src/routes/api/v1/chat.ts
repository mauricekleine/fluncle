import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../-alias";
import { serverHandlers } from "../chat";

export const Route = createFileRoute("/api/v1/chat")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
