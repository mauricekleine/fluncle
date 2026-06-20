import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../me/profile";

export const Route = createFileRoute("/api/v1/me/profile")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
