import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "./-alias";
import { jsonError } from "../../lib/server/env";
import { apiErrorResponse } from "../../lib/server/http-errors";
import { searchTrackCandidates } from "../../lib/server/spotify";

const minQueryLength = 2;

export const serverHandlers: ApiHandlers = {
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
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/search")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
