import { createFileRoute } from "@tanstack/react-router";
import { escapeXml } from "../lib/feed-xml";
import { logPageUrl, siteUrl } from "../lib/fluncle-links";
import { mixtapeCoverUrl } from "../lib/mixtapes";
import { parseArtistsJson } from "../lib/server/artists";
import { getDb, typedRows } from "../lib/server/db";

type TrackRow = {
  album_image_url: string | null;
  artists_json: string;
  item_type: "finding" | "mixtape";

  log_id: string | null;
  note: string | null;
  added_at: string;
  spotify_url: string | null;
  title: string;
  track_id: string;
};

const coverUrl = `${siteUrl}/fluncle-cover.png`;
const faviconUrl = `${siteUrl}/favicon.png`;

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
              tracks.track_id,
              findings.log_id,
              tracks.spotify_url,
              tracks.album_image_url,
              tracks.title,
              tracks.artists_json,
              findings.note,
              findings.added_at
            from findings join tracks on tracks.track_id = findings.track_id
            union all
            select
              'mixtape' as item_type,
              log_id as track_id,
              log_id,
              null as spotify_url,
              null as album_image_url,
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
            row.item_type === "mixtape" ? row.title : `${artists.join(", ")} — ${row.title}`;
          const summary = row.note?.trim() ? `${title}\n\n${row.note.trim()}` : title;

          const link = row.log_id ? logPageUrl(row.log_id) : (row.spotify_url ?? siteUrl);
          const updated = new Date(row.added_at).toISOString();

          const imageUrl =
            row.item_type === "mixtape"
              ? row.log_id
                ? mixtapeCoverUrl(row.log_id)
                : undefined
              : (row.album_image_url ?? undefined);

          const contentHtml = [
            `<p>${escapeXml(title)}</p>`,
            row.note?.trim() ? `<p>${escapeXml(row.note.trim())}</p>` : "",
            imageUrl ? `<p><img src="${escapeXml(imageUrl)}" alt="${escapeXml(title)}"/></p>` : "",
            row.spotify_url
              ? `<p><a href="${escapeXml(row.spotify_url)}">Listen on Spotify</a></p>`
              : "",
          ].join("");

          return `<entry>
  <title>${escapeXml(title)}</title>
  <link rel="alternate" href="${escapeXml(link)}"/>
  <id>${escapeXml(`urn:fluncle:${row.track_id}`)}</id>
  <updated>${updated}</updated>
  ${row.item_type === "mixtape" ? '<category term="mixtape"/>' : ""}
  <summary>${escapeXml(summary)}</summary>
  <content type="html">${escapeXml(contentHtml)}</content>
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
  <logo>${escapeXml(coverUrl)}</logo>
  <icon>${escapeXml(faviconUrl)}</icon>
  <updated>${updated}</updated>
${entries.join("\n")}
</feed>`;

        return new Response(xml, {
          headers: {
            "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
            "Content-Type": "application/atom+xml; charset=utf-8",
          },
        });
      },
    },
  },
});
