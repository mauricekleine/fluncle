import { createFileRoute } from "@tanstack/react-router";
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

export const Route = createFileRoute("/atom.xml")({
  server: {
    handlers: {
      GET: async () => {
        const db = await getDb();
        const result = await db.execute({
          args: [25],
          sql: `select * from (
            select
              'finding' as item_type,
              track_id,
              spotify_url,
              title,
              artists_json,
              note,
              added_at
            from tracks
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
        const entries = rows.map((row) => {
          const artists = parseArtistsJson(row.artists_json);
          const title =
            row.item_type === "mixtape" ? row.title : `${artists.join(", ")} - ${row.title}`;
          const summary = row.note?.trim() ? `${title}\n\n${row.note.trim()}` : title;
          const link =
            row.item_type === "mixtape"
              ? `https://www.fluncle.com/log/${encodeURIComponent(row.track_id)}`
              : (row.spotify_url as string);
          const updated = new Date(row.added_at).toISOString();

          return `<entry>
  <title>${escapeXml(title)}</title>
  <link rel="alternate" href="${escapeXml(link)}"/>
  <id>${escapeXml(`urn:fluncle:${row.track_id}`)}</id>
  <updated>${updated}</updated>
  ${row.item_type === "mixtape" ? '<category term="mixtape"/>' : ""}
  <summary>${escapeXml(summary)}</summary>
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
            "Content-Type": "application/atom+xml; charset=utf-8",
          },
        });
      },
    },
  },
});

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
