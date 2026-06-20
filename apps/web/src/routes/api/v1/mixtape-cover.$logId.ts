import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../-alias";
import { serverHandlers } from "../mixtape-cover.$logId";

export const Route = createFileRoute("/api/v1/mixtape-cover/$logId")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
