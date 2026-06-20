import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../admin/tracks.$trackId.social";

export const Route = createFileRoute("/api/v1/admin/tracks/$trackId/social")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
