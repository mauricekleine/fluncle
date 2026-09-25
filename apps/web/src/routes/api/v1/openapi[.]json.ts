import { createFileRoute } from "@tanstack/react-router";
import { generateOpenApiDocument } from "../../../lib/server/orpc";

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
