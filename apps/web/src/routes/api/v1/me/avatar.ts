import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../me/avatar";

export const Route = createFileRoute("/api/v1/me/avatar")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
