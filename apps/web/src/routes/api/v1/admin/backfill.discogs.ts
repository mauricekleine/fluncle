import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../-alias";
import { serverHandlers } from "../../admin/backfill.discogs";

export const Route = createFileRoute("/api/v1/admin/backfill/discogs")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
