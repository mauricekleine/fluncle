import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../admin/tracks.$trackId.social.$platform";

export const Route = createFileRoute("/api/v1/admin/tracks/$trackId/social/$platform")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
