import { createFileRoute } from "@tanstack/react-router";
import { listFeedEntries } from "../lib/server/feed";

// The JSON feed: the three kinds on the spine in one chronological list (see
// lib/server/feed.ts). A mixtape and a letter each carry their kind as a tag; a
// finding, the default, carries none.

export const Route = createFileRoute("/feed.json")({
  server: {
    handlers: {
      GET: async () => {
        const entries = await listFeedEntries(25);
        const items = entries.map((entry) => {
          const item: {
            content_text: string;
            date_published: string;
            id: string;
            tags?: string[];
            title: string;
            url: string;
          } = {
            content_text: entry.summary,
            date_published: new Date(entry.addedAt).toISOString(),
            id: entry.guid,
            title: entry.title,
            url: entry.link,
          };

          if (entry.kind !== "finding") {
            item.tags = [entry.kind];
          }

          return item;
        });

        const feed = {
          description: "Drum & bass bangers from another dimension.",
          feed_url: "https://www.fluncle.com/feed.json",
          home_page_url: "https://www.fluncle.com",
          items,
          title: "Fluncle's Findings",
          version: "https://jsonfeed.org/version/1.1",
        };

        return new Response(JSON.stringify(feed), {
          headers: {
            // Readers get a short max-age; the CDN holds s-maxage; SWR keeps
            // every repeat poll free while a background refresh runs.
            "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
            "Content-Type": "application/feed+json; charset=utf-8",
          },
        });
      },
    },
  },
});
