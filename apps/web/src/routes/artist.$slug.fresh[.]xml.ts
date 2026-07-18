import { createFileRoute } from "@tanstack/react-router";
import {
  entityFreshChannel,
  freshFeedResponse,
  renderEntityFreshFeed,
} from "../lib/fresh-feed-rss";
import { siteUrl } from "../lib/fluncle-links";
import { listArtistFreshTracks } from "../lib/server/fresh-entity";

// The per-ARTIST sibling of /fresh.xml — the whole-archive release feed narrowed to one artist:
// what just came OUT from this artist, over the same trailing 30-day release-date window. Only the
// artist's OWN tracks ride it, never a widening to similar artists (ratified 2026-07-18). The two
// tiers + the release-framing live in ../lib/fresh-feed-rss. An unknown slug 404s; the feed is
// anonymous + public (the never-gates law).
//
// The unknown-slug 404 is a bare `Response`, not `notFound()` — inside a server handler that router
// throw serializes to a 200 (the sitemap/docs/embed handlers all take this shape for the reason).

export const Route = createFileRoute("/artist/$slug/fresh.xml")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const feed = await listArtistFreshTracks(params.slug);
        if (!feed) {
          return new Response("Not found", { status: 404 });
        }
        const { description, title } = entityFreshChannel("artist", feed.name);
        const xml = renderEntityFreshFeed({
          description,
          link: `${siteUrl}/artist/${params.slug}`,
          title,
          tracks: feed.tracks,
        });
        return freshFeedResponse(xml);
      },
    },
  },
});
