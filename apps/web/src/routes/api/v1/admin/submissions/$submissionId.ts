import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../../../-alias";
import { serverHandlers } from "../../../admin/submissions/$submissionId";

export const Route = createFileRoute("/api/v1/admin/submissions/$submissionId")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
