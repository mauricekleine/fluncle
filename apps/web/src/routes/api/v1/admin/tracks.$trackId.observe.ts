import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../admin/tracks.$trackId.observe";

export const Route = createFileRoute("/api/v1/admin/tracks/$trackId/observe")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
