import { createFileRoute } from "@tanstack/react-router";
import { siteUrl } from "../lib/fluncle-links";
import { itemId, itemLink, itemTitle, releaseInstant } from "../lib/fresh-feed-item";
import { listFreshTracks } from "../lib/server/fresh";
import { releaseBoundFeedCacheControl } from "../lib/server/edge-cache";

const coverUrl = `${siteUrl}/fluncle-cover.png`;
const faviconUrl = `${siteUrl}/favicon.png`;

const channelTitle = "New drum & bass releases · Fluncle";
const channelDescription =
  "The freshest drum & bass, hot off the press. Every release from the last 30 days, tracked as Fluncle spins his way through them.";

export const Route = createFileRoute("/fresh.json")({
  server: {
    handlers: {
      GET: async () => {
        const now = new Date();
        const { tracks } = await listFreshTracks({ limit: 50, now });

        const items = tracks.map((track) => {
          const title = itemTitle(track);
          const link = itemLink(track);

          const contentText = [title, track.spotifyUrl ?? undefined].filter(Boolean).join("\n\n");
          const published = releaseInstant(track.releaseDate);

          const item: {
            content_text: string;
            date_published?: string;
            id: string;
            image?: string;
            title: string;
            url?: string;
          } = {
            content_text: contentText,

            id: itemId(track, link),
            title,
          };
          if (link) {
            item.url = link;
          }
          if (published) {
            item.date_published = published.toISOString();
          }

          if (track.coverImageUrl) {
            item.image = track.coverImageUrl;
          }
          return item;
        });

        const feed = {
          description: channelDescription,
          favicon: faviconUrl,
          feed_url: "https://www.fluncle.com/fresh.json",
          home_page_url: "https://www.fluncle.com/fresh",
          icon: coverUrl,
          items,
          title: channelTitle,
          version: "https://jsonfeed.org/version/1.1",
        };

        return new Response(JSON.stringify(feed), {
          headers: {
            "Cache-Control": releaseBoundFeedCacheControl(now),
            "Content-Type": "application/feed+json; charset=utf-8",
          },
        });
      },
    },
  },
});
