import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../admin/mixtapes.$mixtapeId.social";

export const Route = createFileRoute("/api/v1/admin/mixtapes/$mixtapeId/social")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
