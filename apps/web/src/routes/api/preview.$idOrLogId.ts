import { createFileRoute } from "@tanstack/react-router";
import { enrichFromDeezer } from "../../lib/server/deezer";
import { getTrackByIdOrLogId } from "../../lib/server/tracks";

// Same-origin audio proxy for a track's 30s preview.
//
// The game (and any future in-page playback) runs previews through Web Audio
// for gain/pan, which needs CORS-clean bytes; provider CDNs don't grant that,
// and stored Deezer URLs carry expiring tokens. This route streams whatever
// the track's preview_url points at — provider CDN today, our own R2 copy
// tomorrow — and re-resolves a stale Deezer URL by ISRC as a fallback. It
// never writes; re-resolution is per-request, best-effort.
export const Route = createFileRoute("/api/preview/$idOrLogId")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const track = await getTrackByIdOrLogId(params.idOrLogId);

        if (!track) {
          return Response.json({ error: "Track not found" }, { status: 404 });
        }

        const stored = track.previewUrl;
        const upstream = stored ? await fetchPreview(stored) : undefined;

        if (upstream) {
          return proxied(upstream);
        }

        // Stored URL missing or stale (expired token); re-resolve by ISRC.
        const fresh = (await enrichFromDeezer(track.isrc)).previewUrl;
        const refetched = fresh && fresh !== stored ? await fetchPreview(fresh) : undefined;

        if (refetched) {
          return proxied(refetched);
        }

        return Response.json({ error: "No preview available" }, { status: 404 });
      },
    },
  },
});

async function fetchPreview(url: string): Promise<Response | undefined> {
  try {
    const response = await fetch(url);

    return response.ok && response.body ? response : undefined;
  } catch {
    return undefined;
  }
}

function proxied(upstream: Response): Response {
  return new Response(upstream.body, {
    headers: {
      // Previews are immutable per track; cache briefly so a session's
      // re-fetches don't hammer the provider, but stay under token lifetimes.
      "cache-control": "public, max-age=3600",
      "content-type": upstream.headers.get("content-type") ?? "audio/mpeg",
    },
  });
}
