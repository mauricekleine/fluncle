import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../me/saved-findings";

export const Route = createFileRoute("/api/v1/me/saved-findings")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
