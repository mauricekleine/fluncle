import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../../../-alias";
import { serverHandlers } from "../../../../admin/submissions/$submissionId/approve";

export const Route = createFileRoute("/api/v1/admin/submissions/$submissionId/approve")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
