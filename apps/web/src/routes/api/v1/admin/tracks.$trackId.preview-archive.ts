import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../admin/tracks.$trackId.preview-archive";

export const Route = createFileRoute("/api/v1/admin/tracks/$trackId/preview-archive")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
