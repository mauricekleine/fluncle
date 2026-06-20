import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../admin/mixtapes.$mixtapeId.mixcloud.finalize";

export const Route = createFileRoute("/api/v1/admin/mixtapes/$mixtapeId/mixcloud/finalize")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
