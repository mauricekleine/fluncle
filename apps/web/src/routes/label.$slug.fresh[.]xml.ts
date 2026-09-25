import { createFileRoute } from "@tanstack/react-router";
import {
  entityFreshChannel,
  freshFeedResponse,
  renderEntityFreshFeed,
} from "../lib/fresh-feed-rss";
import { siteUrl } from "../lib/fluncle-links";
import { listLabelFreshTracks } from "../lib/server/fresh-entity";
import { releaseBoundFeedCacheControl } from "../lib/server/edge-cache";

export const Route = createFileRoute("/label/$slug/fresh.xml")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const now = new Date();
        const feed = await listLabelFreshTracks(params.slug, { now });
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
        return freshFeedResponse(xml, releaseBoundFeedCacheControl(now));
      },
    },
  },
});
