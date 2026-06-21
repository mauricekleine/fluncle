import { createFileRoute } from "@tanstack/react-router";
import { generateOpenApiDocument } from "../../../lib/server/orpc";
import { openApiToPostman } from "../../../lib/server/openapi-to-postman";

// A Postman Collection v2.1, served at /api/v1/postman.json so it lives under
// the same versioned base it describes. It is derived from the GENERATED OpenAPI
// 3.1 document (the source of truth — the same public spec served at
// /api/v1/openapi.json) at request time, so it can never drift from the spec and
// needs no separate maintenance: import this in Postman and every endpoint,
// parameter, and example body tracks the generated spec exactly.
export const Route = createFileRoute("/api/v1/postman.json")({
  server: {
    handlers: {
      GET: async () => {
        const document = await generateOpenApiDocument();

        return new Response(JSON.stringify(openApiToPostman(document)), {
          headers: {
            "Cache-Control": "public, max-age=3600",
            "Content-Type": "application/json",
          },
        });
      },
    },
  },
});
