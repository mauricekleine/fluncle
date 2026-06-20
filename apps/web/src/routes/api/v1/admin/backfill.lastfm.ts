import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../admin/backfill.lastfm";

export const Route = createFileRoute("/api/v1/admin/backfill/lastfm")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
