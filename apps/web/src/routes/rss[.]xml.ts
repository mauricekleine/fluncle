import { createFileRoute } from "@tanstack/react-router";
import { getDb } from "../lib/server/db";

type TrackRow = {
  track_id: string;
  spotify_url: string;
  title: string;
  artists_json: string;
  note: string | null;
  added_at: string;
};

export const Route = createFileRoute("/rss.xml")({
  server: {
    handlers: {
      GET: async () => {
        const db = await getDb();
        const result = await db.execute({
          args: [25],
          sql: `select
              track_id,
              spotify_url,
              title,
              artists_json,
              note,
              added_at
            from tracks
            order by added_at desc, track_id desc
            limit ?`,
        });
        const rows = result.rows as unknown as TrackRow[];
        const newestDate = rows[0]?.added_at;
        const items = rows.map((row) => {
          const artists = parseArtists(row.artists_json);
          const title = `${artists.join(", ")} - ${row.title}`;
          const description = row.note?.trim()
            ? `${artists.join(", ")} - ${row.title}\n\n${row.note.trim()}`
            : `${artists.join(", ")} - ${row.title}`;

          return `<item>
  <title>${escapeXml(title)}</title>
  <link>${escapeXml(row.spotify_url)}</link>
  <guid isPermaLink="false">${escapeXml(row.track_id)}</guid>
  <pubDate>${new Date(row.added_at).toUTCString()}</pubDate>
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
            "Content-Type": "application/rss+xml; charset=utf-8",
          },
        });
      },
    },
  },
});

function parseArtists(value: string): string[] {
  try {
    const artists = JSON.parse(value) as unknown;

    if (Array.isArray(artists)) {
      return artists.filter((artist): artist is string => typeof artist === "string");
    }
  } catch {
    return [];
  }

  return [];
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
