import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../-alias";
import { serverHandlers } from "../submissions";

export const Route = createFileRoute("/api/v1/submissions")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
