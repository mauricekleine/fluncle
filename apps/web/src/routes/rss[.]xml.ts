import { createFileRoute } from "@tanstack/react-router";
import { escapeXml } from "../lib/feed-xml";
import { listFeedEntries } from "../lib/server/feed";

// The RSS feed: the three kinds on the spine in one chronological list (see
// lib/server/feed.ts). A mixtape and a letter each carry an `object-type` category, so
// the feed is honest about what an item is; a finding, the default, carries none.

export const Route = createFileRoute("/rss.xml")({
  server: {
    handlers: {
      GET: async () => {
        const entries = await listFeedEntries(25);
        const newestDate = entries[0]?.addedAt;
        const items = entries.map((entry) => {
          const category =
            entry.kind === "finding"
              ? ""
              : `<category domain="https://www.fluncle.com/ns/object-type">${entry.kind}</category>`;

          return `<item>
  <title>${escapeXml(entry.title)}</title>
  <link>${escapeXml(entry.link)}</link>
  <guid isPermaLink="false">${escapeXml(entry.guid)}</guid>
  <pubDate>${new Date(entry.addedAt).toUTCString()}</pubDate>
  ${category}
  <description>${escapeXml(entry.summary)}</description>
</item>`;
        });
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>Fluncle's Findings</title>
  <link>https://www.fluncle.com</link>
  <description>Drum &amp; bass bangers from another dimension.</description>
  ${newestDate ? `<lastBuildDate>${new Date(newestDate).toUTCString()}</lastBuildDate>` : ""}
${items.join("\n")}
</channel>
</rss>`;

        return new Response(xml, {
          headers: {
            // Readers get a short max-age; the CDN holds s-maxage; SWR keeps
            // every repeat poll free while a background refresh runs.
            "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
            "Content-Type": "application/rss+xml; charset=utf-8",
          },
        });
      },
    },
  },
});
