import { createFileRoute } from "@tanstack/react-router";
import { readSpotifyHopTarget } from "@/lib/server/identity-envelope";
import { logEvent } from "@/lib/server/log";
import { requireParam } from "@/lib/server/http-errors";

// THE SPOTIFY HOP (RFC dnb-identity-graph, ruling 7). A 302 from Fluncle's own domain to the
// recording's stored Spotify URL.
//
// THE KEY IS FLUNCLE'S TRACK ID, NEVER A SPOTIFY ID THE URL ASSERTS. The design: the path names a
// row in Fluncle's archive, so a caller reading the URL learns nothing about which Spotify resource
// it points at, and the cross-identifier graph stays behind the metered read that exists to hand it
// out deliberately. The raw link stays STORED — nothing about the archive changed — and this route
// is what resolves it.
//
// WHAT THAT IS AND IS NOT WORTH, precisely, because the difference is easy to overstate: a
// PUBLISH-BORN finding's `track_id` IS its Spotify track id (publish.ts derives the PK from the
// operator's Spotify URL), so for those rows the hop path and the Spotify id coincide. No exposure
// follows — `trackId` is already on the public track DTO — but the concealment is real only for the
// CRAWLER-born rows keyed `mb_<mbid>`, which is the whole catalogue and the half a harvester would
// actually want. The rule holds as a rule: this route never accepts a Spotify id AS the key, so it
// can never become a public Spotify-id → link oracle for a row that does not already publish one.
//
// A redirect emits no JSON, so it is a file route rather than an oRPC op, the same class as the
// OAuth callbacks and the feeds (AGENTS.md § Architecture). It lives outside `routes/api`, so
// neither coverage net enumerates it.
//
// UNKNOWN OR UN-ANCHORED ⇒ 404. A recording with no Spotify link has nowhere honest to send the
// visitor, and bouncing to a search page would be guessing on their behalf.
//
// THE LOG LINE is the harvest tripwire: one `logEvent` per hop with the track id, so a run of
// thousands under one pattern is visible in the Worker's logs rather than inferred later from a
// bill. It carries no address of its own; the request's own edge metadata already does that.

/**
 * The hop itself, exported so the suite can drive it directly (the `api/admin/logout.ts`
 * `serverHandlers` precedent) — a redirect is worth a test, and reaching into a route's options to
 * find one is worse than naming it here.
 */
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
      // Short and private: the hop must stay countable (a cached redirect is a hop nobody sees)
      // while still sparing a repeated tap in the same session a round trip.
      "Cache-Control": "private, max-age=60",
      Location: target,
    },
    status: 302,
  });
}

export const Route = createFileRoute("/out/spotify/$trackId")({
  server: { handlers: { GET: async ({ params }) => spotifyHop(params.trackId) } },
});
