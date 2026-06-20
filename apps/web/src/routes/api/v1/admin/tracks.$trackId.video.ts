import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../admin/tracks.$trackId.video";

export const Route = createFileRoute("/api/v1/admin/tracks/$trackId/video")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
