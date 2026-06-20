import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../me/export.$exportId";

export const Route = createFileRoute("/api/v1/me/export/$exportId")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
