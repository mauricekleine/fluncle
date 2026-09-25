import { createFileRoute } from "@tanstack/react-router";
import { jsonError } from "../../lib/server/env";
import {
  apiErrorResponse,
  requireParam,
  trackNotFoundResponse,
} from "../../lib/server/http-errors";
import { fetchLivePreview } from "../../lib/server/preview-live";
import { getLivePreviewTrack } from "../../lib/server/tracks";
import { type ApiHandlers, aliasHandlers } from "./-alias";

const corsHeaders = {
  "access-control-allow-headers": "range",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-origin": "*",
};

export const serverHandlers: ApiHandlers = {
  GET: async ({ params, request }) => {
    const idOrLogId = requireParam(params.idOrLogId, "idOrLogId");

    try {
      const track = await getLivePreviewTrack(idOrLogId);

      if (!track) {
        return trackNotFoundResponse(idOrLogId);
      }

      const upstream = await fetchLivePreview(track, request);

      if (!upstream) {
        return jsonError(404, "no_preview", "No preview available for this finding.");
      }

      const headers = new Headers(corsHeaders);

      for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
        const value = upstream.headers.get(name);

        if (value) {
          headers.set(name, value);
        }
      }

      if (!headers.has("content-type")) {
        headers.set("content-type", "audio/mpeg");
      }

      headers.set("cache-control", "no-store");

      return new Response(upstream.body, { headers, status: upstream.status });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
  OPTIONS: () => new Response(undefined, { headers: corsHeaders, status: 204 }),
};

export const Route = createFileRoute("/api/preview/$idOrLogId")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
