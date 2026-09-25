import { createFileRoute } from "@tanstack/react-router";
import { readSpotifyHopTarget } from "@/lib/server/identity-envelope";
import { logEvent } from "@/lib/server/log";
import { requireParam } from "@/lib/server/http-errors";

export async function spotifyHop(rawTrackId: string | undefined): Promise<Response> {
  const trackId = requireParam(rawTrackId, "trackId");
  const target = await readSpotifyHopTarget(trackId);

  if (!target) {
    logEvent("info", "hop.spotify-miss", { trackId });

    return new Response("Not found", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      status: 404,
    });
  }

  logEvent("info", "hop.spotify", { trackId });

  return new Response(null, {
    headers: {
      "Cache-Control": "private, max-age=60",
      Location: target,
    },
    status: 302,
  });
}

export const Route = createFileRoute("/out/spotify/$trackId")({
  server: { handlers: { GET: async ({ params }) => spotifyHop(params.trackId) } },
});
