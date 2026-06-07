import { createFileRoute } from "@tanstack/react-router";

// Liveness probe, linked as the "status" relation from /.well-known/api-catalog
// (RFC 9727). Deliberately cheap: no Turso round-trip per poll.
export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: () =>
        Response.json(
          { ok: true },
          {
            headers: {
              "Cache-Control": "no-store",
            },
          },
        ),
    },
  },
});
