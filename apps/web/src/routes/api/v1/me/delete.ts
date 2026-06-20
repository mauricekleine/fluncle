import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../me/delete";

export const Route = createFileRoute("/api/v1/me/delete")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
