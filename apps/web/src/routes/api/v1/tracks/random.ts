import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../tracks/random";

export const Route = createFileRoute("/api/v1/tracks/random")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
