import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../admin/tracks.$trackId.silent-clip";

export const Route = createFileRoute("/api/v1/admin/tracks/$trackId/silent-clip")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
