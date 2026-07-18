import { createFileRoute } from "@tanstack/react-router";
import {
  entityFreshChannel,
  freshFeedResponse,
  renderEntityFreshFeed,
} from "../lib/fresh-feed-rss";
import { siteUrl } from "../lib/fluncle-links";
import { listLabelFreshTracks } from "../lib/server/fresh-entity";

// The per-LABEL sibling of /fresh.xml — the whole-archive release feed narrowed to one label:
// what just came OUT on this label, over the same trailing 30-day release-date window. Only the
// label's OWN tracks ride it, never a widening to similar labels (ratified 2026-07-18). The two
// tiers + the release-framing live in ../lib/fresh-feed-rss. An unknown slug 404s; the feed is
// anonymous + public (the never-gates law).
//
// The unknown-slug 404 is a bare `Response`, not `notFound()` — inside a server handler that router
// throw serializes to a 200 (the sitemap/docs/embed handlers all take this shape for the reason).

export const Route = createFileRoute("/label/$slug/fresh.xml")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const feed = await listLabelFreshTracks(params.slug);
        if (!feed) {
          return new Response("Not found", { status: 404 });
        }
        const { description, title } = entityFreshChannel("label", feed.name);
        const xml = renderEntityFreshFeed({
          description,
          link: `${siteUrl}/label/${params.slug}`,
          title,
          tracks: feed.tracks,
        });
        return freshFeedResponse(xml);
      },
    },
  },
});
