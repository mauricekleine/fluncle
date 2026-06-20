import { createFileRoute } from "@tanstack/react-router";
import openapi from "../../../../public/openapi.json";

// The OpenAPI 3.1 document, served at /api/v1/openapi.json so the spec lives
// under the same versioned base it describes (and the docs page can embed it
// there). The same bytes are also served statically at /openapi.json from
// public/; this route imports that one file so the two never drift.
export const Route = createFileRoute("/api/v1/openapi.json")({
  server: {
    handlers: {
      GET: () =>
        new Response(JSON.stringify(openapi), {
          headers: {
            "Cache-Control": "public, max-age=3600",
            "Content-Type": "application/openapi+json",
          },
        }),
    },
  },
});
