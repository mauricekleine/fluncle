import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../admin/tracks.$trackId.social.$platform.draft";

export const Route = createFileRoute("/api/v1/admin/tracks/$trackId/social/$platform/draft")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
