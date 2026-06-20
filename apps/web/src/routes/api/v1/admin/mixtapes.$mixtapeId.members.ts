import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../admin/mixtapes.$mixtapeId.members";

export const Route = createFileRoute("/api/v1/admin/mixtapes/$mixtapeId/members")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
