import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../admin/mixtapes.$mixtapeId.youtube.publish";

export const Route = createFileRoute("/api/v1/admin/mixtapes/$mixtapeId/youtube/publish")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
