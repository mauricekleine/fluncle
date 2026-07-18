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
  // The permanent coordinate: a finding's `findings.log_id` (its /log home), or a
  // mixtape's own Log ID. NULL only for a coordinate-less finding straggler.
  log_id: string | null;
  note: string | null;
  added_at: string;
  spotify_url: string | null;
  title: string;
  track_id: string;
};

// The site cover, reused for the feed-level image other pages fall back to.
const coverUrl = `${siteUrl}/fluncle-cover.png`;

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
        const items = rows.map((row) => {
          const artists = parseArtistsJson(row.artists_json);
          const title =
            row.item_type === "mixtape" ? row.title : `${artists.join(", ")} - ${row.title}`;
          // A finding's home is its own /log page (the citation surface the archive
          // owns); Spotify stays in the body. Fall back to Spotify only when no
          // coordinate has been minted yet.
          const link = row.log_id ? logPageUrl(row.log_id) : (row.spotify_url ?? siteUrl);
          // Keep the Spotify link reachable from the item body now that it is no
          // longer the item link.
          const description = [title, row.note?.trim() || undefined, row.spotify_url ?? undefined]
            .filter(Boolean)
            .join("\n\n");
          // A mixtape's cover renders on the fly from its Log ID; a finding carries
          // its album cover. `media:content` avoids `enclosure`'s required byte length.
          const imageUrl =
            row.item_type === "mixtape"
              ? row.log_id
                ? mixtapeCoverUrl(row.log_id)
                : undefined
              : (row.album_image_url ?? undefined);

          return `<item>
  <title>${escapeXml(title)}</title>
  <link>${escapeXml(link)}</link>
  <guid isPermaLink="false">${escapeXml(row.track_id)}</guid>
  <pubDate>${new Date(row.added_at).toUTCString()}</pubDate>
  ${row.item_type === "mixtape" ? '<category domain="https://www.fluncle.com/ns/object-type">mixtape</category>' : ""}
  ${imageUrl ? `<media:content url="${escapeXml(imageUrl)}" medium="image"/>` : ""}
  <description>${escapeXml(description)}</description>
</item>`;
        });
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
  <title>Fluncle's Findings</title>
  <link>https://www.fluncle.com</link>
  <description>Drum &amp; bass bangers from another dimension.</description>
  <image>
    <url>${escapeXml(coverUrl)}</url>
    <title>Fluncle's Findings</title>
    <link>https://www.fluncle.com</link>
  </image>
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
