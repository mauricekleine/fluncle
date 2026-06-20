import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../me/export";

export const Route = createFileRoute("/api/v1/me/export")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
