import { createFileRoute } from "@tanstack/react-router";
import { generateOpenApiDocument } from "../../../lib/server/orpc";

// TEMP (Phase 1 of the oRPC migration). The OpenAPI 3.1 fragment GENERATED from
// the oRPC contract registry — proof that the spec derives from the same
// contracts that serve the requests, not the hand-maintained public/openapi.json.
//
// It is served alongside (not in place of) the static /api/v1/openapi.json so the
// generated fragment can be diffed against the canonical spec as routes convert.
// A later phase points /api/v1/openapi.json at this generator and deletes the
// static file; until then this route stays so the two can be compared.
export const Route = createFileRoute("/api/v1/orpc-openapi.json")({
  server: {
    handlers: {
      GET: async () => {
        const document = await generateOpenApiDocument();

        return new Response(JSON.stringify(document, null, 2), {
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "application/openapi+json",
          },
        });
      },
    },
  },
});
