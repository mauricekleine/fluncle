import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../-alias";
import { serverHandlers } from "../og.$logId";

export const Route = createFileRoute("/api/v1/og/$logId")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
