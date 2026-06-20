import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "./-alias";

// Liveness probe, linked as the "status" relation from /.well-known/api-catalog
// (RFC 9727). Deliberately cheap: no Turso round-trip per poll.
//
// Handlers live in a shared `serverHandlers` object so the canonical /api/v1
// mount (./v1/health) and the permanent /api back-compat alias serve identical
// behaviour from this one source.
export const serverHandlers: ApiHandlers = {
  GET: () =>
    Response.json(
      { ok: true },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    ),
};

export const Route = createFileRoute("/api/health")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
