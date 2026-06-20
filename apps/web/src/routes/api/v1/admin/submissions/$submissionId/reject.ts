import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../../../-alias";
import { serverHandlers } from "../../../../admin/submissions/$submissionId/reject";

export const Route = createFileRoute("/api/v1/admin/submissions/$submissionId/reject")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
