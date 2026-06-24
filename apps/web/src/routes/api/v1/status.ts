import { createFileRoute } from "@tanstack/react-router";
import { aliasHandlers } from "../-alias";
import { serverHandlers } from "../status";

// Canonical /api/v1 mount. The handlers come from the back-compat /api route so
// both paths serve one implementation; see ../status for the source of truth. A
// public, non-oRPC status read (carved out of the contract-coverage net) — the
// machine-readable sibling of the /status HTML dashboard.
export const Route = createFileRoute("/api/v1/status")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
