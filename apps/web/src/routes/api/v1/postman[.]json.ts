import { createFileRoute } from "@tanstack/react-router";
import openapi from "../../../../public/openapi.json";
import { openApiToPostman } from "../../../lib/server/openapi-to-postman";

// A Postman Collection v2.1, served at /api/v1/postman.json so it lives under
// the same versioned base it describes. It is derived from the OpenAPI 3.1
// document (the source of truth) at request time, so it can never drift from
// the spec and needs no separate maintenance: import this in Postman and every
// endpoint, parameter, and example body tracks openapi.json exactly.
export const Route = createFileRoute("/api/v1/postman.json")({
  server: {
    handlers: {
      GET: () =>
        new Response(JSON.stringify(openApiToPostman(openapi)), {
          headers: {
            "Cache-Control": "public, max-age=3600",
            "Content-Type": "application/json",
          },
        }),
    },
  },
});
