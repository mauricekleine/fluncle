import { createFileRoute } from "@tanstack/react-router";
import { escapeXml } from "../lib/feed-xml";
import { parseArtistsJson } from "../lib/server/artists";
import { getDb, typedRows } from "../lib/server/db";

type TrackRow = {
  artists_json: string;
  item_type: "finding" | "mixtape";
  note: string | null;
  added_at: string;
  spotify_url: string | null;
  title: string;
  track_id: string;
};

export const Route = createFileRoute("/rss.xml")({
  server: {
    handlers: {
      GET: async () => {
        const db = await getDb();
        const result = await db.execute({
          args: [25],
          sql: `select * from (
            select
              'finding' as item_type,
              tracks.track_id,
              tracks.spotify_url,
              tracks.title,
              tracks.artists_json,
              findings.note,
              findings.added_at
            from findings join tracks on tracks.track_id = findings.track_id
            union all
            select
              'mixtape' as item_type,
              log_id as track_id,
              null as spotify_url,
              title,
              '["Fluncle"]' as artists_json,
              note,
              added_at
            from mixtapes
            where status = 'published' and log_id is not null and added_at is not null
          )
            order by added_at desc, track_id desc
            limit ?`,
        });
        const rows = typedRows<TrackRow>(result.rows);
        const newestDate = rows[0]?.added_at;
        const items = rows.map((row) => {
          const artists = parseArtistsJson(row.artists_json);
          const title =
            row.item_type === "mixtape" ? row.title : `${artists.join(", ")} - ${row.title}`;
          const description = row.note?.trim() ? `${title}\n\n${row.note.trim()}` : title;
          const link =
            row.item_type === "mixtape"
              ? `https://www.fluncle.com/log/${encodeURIComponent(row.track_id)}`
              : (row.spotify_url as string);

          return `<item>
  <title>${escapeXml(title)}</title>
  <link>${escapeXml(link)}</link>
  <guid isPermaLink="false">${escapeXml(row.track_id)}</guid>
  <pubDate>${new Date(row.added_at).toUTCString()}</pubDate>
  ${row.item_type === "mixtape" ? '<category domain="https://www.fluncle.com/ns/object-type">mixtape</category>' : ""}
  <description>${escapeXml(description)}</description>
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
