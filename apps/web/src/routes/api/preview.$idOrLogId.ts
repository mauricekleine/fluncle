import { createFileRoute } from "@tanstack/react-router";
import { enrichFromDeezer } from "../../lib/server/deezer";
import { jsonError } from "../../lib/server/env";
import { getTrackByIdOrLogId } from "../../lib/server/tracks";

// Streams a finding's official 30s preview (Deezer/iTunes — never YouTube;
// see the roadmap's audio policy). The proxy exists because the stored Deezer
// URLs carry expiring tokens and the Deezer CDN doesn't grant the CORS that
// Web Audio's gain/pan graph needs — so we re-resolve on demand and serve the
// bytes with open CORS. Shared by the feed's in-place preview, the Stories
// player, and (later) the Galaxy game. Not hard-bound to Deezer: whatever
// `preview_url`-shaped source the row carries gets streamed first, with the
// Deezer-by-ISRC lookup as the refresh path.

const corsHeaders = {
  "access-control-allow-headers": "range",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-origin": "*",
};

export const Route = createFileRoute("/api/preview/$idOrLogId")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const idOrLogId = new URL(request.url).pathname.split("/").filter(Boolean).pop() ?? "";

        try {
          const track = await getTrackByIdOrLogId(idOrLogId);

          if (!track) {
            return jsonError(404, "not_found", `No track with id ${idOrLogId}`);
          }

          const upstream = await fetchPreview(track.previewUrl, track.isrc, request);

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

          // The preview for a given finding is stable content; let the edge
          // hold it for a day so repeat plays don't re-hit Deezer.
          headers.set("cache-control", "public, max-age=86400");

          return new Response(upstream.body, { headers, status: upstream.status });
        } catch (error) {
          return jsonError(500, "error", error instanceof Error ? error.message : String(error));
        }
      },
      OPTIONS: () => new Response(undefined, { headers: corsHeaders, status: 204 }),
    },
  },
});

// Try the stored preview URL first; when its token has expired (Deezer answers
// 403/410/404), re-resolve a fresh URL by ISRC and retry once.
async function fetchPreview(
  storedUrl: string | undefined,
  isrc: string | undefined,
  request: Request,
): Promise<Response | undefined> {
  const range = request.headers.get("range");
  const upstreamInit: RequestInit = range ? { headers: { range } } : {};

  if (storedUrl) {
    const response = await fetch(storedUrl, upstreamInit);

    if (response.ok || response.status === 206) {
      return response;
    }
  }

  const refreshed = await enrichFromDeezer(isrc);

  if (refreshed.previewUrl && refreshed.previewUrl !== storedUrl) {
    const response = await fetch(refreshed.previewUrl, upstreamInit);

    if (response.ok || response.status === 206) {
      return response;
    }
  }

  return undefined;
}
