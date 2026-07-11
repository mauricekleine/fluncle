import { createFileRoute } from "@tanstack/react-router";
import { escapeXml } from "../lib/feed-xml";
import { listFeedEntries } from "../lib/server/feed";

// The Atom feed: the three kinds on the spine in one chronological list (see
// lib/server/feed.ts). A mixtape and a letter each carry a `<category>` term; a
// finding, the default, carries none.

export const Route = createFileRoute("/atom.xml")({
  server: {
    handlers: {
      GET: async () => {
        const feedEntries = await listFeedEntries(25);
        const newestDate = feedEntries[0]?.addedAt;
        const entries = feedEntries.map((entry) => {
          const category = entry.kind === "finding" ? "" : `<category term="${entry.kind}"/>`;

          return `<entry>
  <title>${escapeXml(entry.title)}</title>
  <link rel="alternate" href="${escapeXml(entry.link)}"/>
  <id>${escapeXml(`urn:fluncle:${entry.guid}`)}</id>
  <updated>${new Date(entry.addedAt).toISOString()}</updated>
  ${category}
  <summary>${escapeXml(entry.summary)}</summary>
</entry>`;
        });

        const updated = newestDate ? new Date(newestDate).toISOString() : new Date(0).toISOString();
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Fluncle's Findings</title>
  <subtitle>Drum &amp; bass bangers from another dimension.</subtitle>
  <id>https://www.fluncle.com/</id>
  <link rel="self" href="https://www.fluncle.com/atom.xml"/>
  <link rel="alternate" href="https://www.fluncle.com"/>
  <author>
    <name>Fluncle</name>
  </author>
  <updated>${updated}</updated>
${entries.join("\n")}
</feed>`;

        return new Response(xml, {
          headers: {
            // Readers get a short max-age; the CDN holds s-maxage; SWR keeps
            // every repeat poll free while a background refresh runs.
            "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
            "Content-Type": "application/atom+xml; charset=utf-8",
          },
        });
      },
    },
  },
});
