import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../-alias";
import { serverHandlers } from "../health";

// Canonical /api/v1 mount. The handlers come from the back-compat /api route so
// both paths serve one implementation; see ../health for the source of truth.
export const Route = createFileRoute("/api/v1/health")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
