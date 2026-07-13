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

// Streams a finding's official 30s preview (Deezer/iTunes — never YouTube;
// see the roadmap's audio policy). The proxy exists because the stored Deezer
// URLs carry expiring tokens and the Deezer CDN doesn't grant the CORS that
// Web Audio's gain/pan graph needs — so we re-resolve on demand and serve the
// bytes with open CORS. Shared by the feed's in-place preview, the Stories
// player, and the Galaxy game. Public playback stays live-only: stored Deezer
// URL first, refreshed Deezer by ISRC next, iTunes last. Operator-only archived
// previews in R2 are private analysis artifacts and are never a playback source.

const corsHeaders = {
  "access-control-allow-headers": "range",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-origin": "*",
};

export const serverHandlers: ApiHandlers = {
  GET: async ({ params, request }) => {
    const idOrLogId = requireParam(params.idOrLogId, "idOrLogId");

    try {
      // Resolve from `tracks` (LEFT join findings), so a CATALOGUE row previews too — the Ear's
      // inline artwork audition (docs/the-ear.md). The preview is the official Deezer/Apple/iTunes
      // 30s clip; a catalogue row's clip is as public as a finding's.
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

      // Keep public playback a live relay only: no edge cache, no R2
      // playback tier, and no durable public copy.
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
