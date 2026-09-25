import { createFileRoute } from "@tanstack/react-router";
import { generateOpenApiDocument } from "../../../lib/server/orpc";
import { openApiToPostman } from "../../../lib/server/openapi-to-postman";

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
