import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../admin/tracks.$trackId.source-audio";

export const Route = createFileRoute("/api/v1/admin/tracks/$trackId/source-audio")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
