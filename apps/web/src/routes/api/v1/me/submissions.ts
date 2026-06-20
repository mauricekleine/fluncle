import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../me/submissions";

export const Route = createFileRoute("/api/v1/me/submissions")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
