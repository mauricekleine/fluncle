import { createFileRoute } from "@tanstack/react-router";
import { jsonError } from "../../lib/server/env";
import { ApiError, searchTrackCandidates } from "../../lib/server/spotify";

const minQueryLength = 2;

export const Route = createFileRoute("/api/search")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const query = url.searchParams.get("q")?.trim() ?? "";

        if (query.length < minQueryLength) {
          return jsonError(400, "invalid_query", "Search query must be at least 2 characters");
        }

        try {
          const results = await searchTrackCandidates(query);

          return Response.json({
            ok: true,
            results,
          });
        } catch (error) {
          if (error instanceof ApiError) {
            return jsonError(error.status, error.code, error.message);
          }

          return jsonError(500, "error", error instanceof Error ? error.message : String(error));
        }
      },
    },
  },
});
