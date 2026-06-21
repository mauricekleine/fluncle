import { createFileRoute } from "@tanstack/react-router";
import { generateOpenApiDocument } from "../../../lib/server/orpc";

// The OpenAPI 3.1 document, served at /api/v1/openapi.json so the spec lives under
// the same versioned base it describes (and the docs page can embed it there). It
// is GENERATED from the oRPC contract registry (apps/web/src/lib/server/orpc.ts),
// not a hand-maintained file — so the spec can never drift from the handlers that
// implement it. Only the PUBLIC ops are exposed; the admin tier is filtered out in
// the generator. Scalar (/docs/api) and the Postman route consume this document.
export const Route = createFileRoute("/api/v1/openapi.json")({
  server: {
    handlers: {
      GET: async () => {
        const document = await generateOpenApiDocument();

        return new Response(JSON.stringify(document), {
          headers: {
            "Cache-Control": "public, max-age=3600",
            "Content-Type": "application/openapi+json",
          },
        });
      },
    },
  },
});
