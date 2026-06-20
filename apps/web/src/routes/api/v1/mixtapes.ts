import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../-alias";
import { serverHandlers } from "../mixtapes";

export const Route = createFileRoute("/api/v1/mixtapes")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
