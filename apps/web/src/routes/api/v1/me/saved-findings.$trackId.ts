import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../me/saved-findings.$trackId";

export const Route = createFileRoute("/api/v1/me/saved-findings/$trackId")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
