import { createFileRoute } from "@tanstack/react-router";
import { generateOpenApiDocument } from "../../../lib/server/orpc";

// SPIKE (de-risking, not the migration). The OpenAPI fragment GENERATED from
// the oRPC contract — proof that the spec derives from the same contracts that
// serve the requests (RFC Unit D), not a hand-maintained file. A plain TanStack
// file-route sitting right beside the oRPC-owned `/api/v1/orpc/*` prefix, which
// demonstrates the two routers coexist in one Worker without conflict.
export const Route = createFileRoute("/api/v1/spike-orpc-openapi.json")({
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
