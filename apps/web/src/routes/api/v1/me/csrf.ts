import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../me/csrf";

export const Route = createFileRoute("/api/v1/me/csrf")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
