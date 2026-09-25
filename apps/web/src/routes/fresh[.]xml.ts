import { createFileRoute } from "@tanstack/react-router";
import { escapeXml } from "../lib/feed-xml";
import { siteUrl } from "../lib/fluncle-links";
import { itemId, itemLink, itemTitle, releaseInstant } from "../lib/fresh-feed-item";
import { listFreshTracks } from "../lib/server/fresh";
import { releaseBoundFeedCacheControl } from "../lib/server/edge-cache";

const coverUrl = `${siteUrl}/fluncle-cover.png`;

const channelTitle = "New drum & bass releases · Fluncle";
const channelDescription =
  "The freshest drum & bass, hot off the press. Every release from the last 30 days, tracked as Fluncle spins his way through them.";

export const Route = createFileRoute("/fresh.xml")({
  server: {
    handlers: {
      GET: async () => {
        const now = new Date();
        const { tracks } = await listFreshTracks({ limit: 50, now });
        const newest = tracks[0]?.releaseDate;
        const newestInstant = newest ? releaseInstant(newest) : undefined;

        const items = tracks.map((track) => {
          const title = itemTitle(track);
          const link = itemLink(track);

          const description = [title, track.spotifyUrl ?? undefined].filter(Boolean).join("\n\n");
          const published = releaseInstant(track.releaseDate);

          const imageUrl = track.coverImageUrl;

          return `<item>
  <title>${escapeXml(title)}</title>
  ${link ? `<link>${escapeXml(link)}</link>` : ""}
  <guid isPermaLink="false">${escapeXml(itemId(track, link))}</guid>
  ${published ? `<pubDate>${published.toUTCString()}</pubDate>` : ""}
  ${imageUrl ? `<media:content url="${escapeXml(imageUrl)}" medium="image"/>` : ""}
  <description>${escapeXml(description)}</description>
</item>`;
        });

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
  <title>${escapeXml(channelTitle)}</title>
  <link>https://www.fluncle.com/fresh</link>
  <description>${escapeXml(channelDescription)}</description>
  <image>
    <url>${escapeXml(coverUrl)}</url>
    <title>${escapeXml(channelTitle)}</title>
    <link>https://www.fluncle.com/fresh</link>
  </image>
  ${newestInstant ? `<lastBuildDate>${newestInstant.toUTCString()}</lastBuildDate>` : ""}
${items.join("\n")}
</channel>
</rss>`;

        return new Response(xml, {
          headers: {
            "Cache-Control": releaseBoundFeedCacheControl(now),
            "Content-Type": "application/rss+xml; charset=utf-8",
          },
        });
      },
    },
  },
});
