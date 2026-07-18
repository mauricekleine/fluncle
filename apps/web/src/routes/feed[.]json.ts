import { createFileRoute } from "@tanstack/react-router";
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

// The feed-level icon (site cover) + favicon, the images other pages fall back to.
const coverUrl = `${siteUrl}/fluncle-cover.png`;
const faviconUrl = `${siteUrl}/favicon.png`;

export const Route = createFileRoute("/feed.json")({
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
        const items = rows.map((row) => {
          const artists = parseArtistsJson(row.artists_json);
          const title =
            row.item_type === "mixtape" ? row.title : `${artists.join(", ")} - ${row.title}`;
          // Keep the Spotify link reachable from the item body now that the item URL
          // points to the /log home.
          const contentText = [title, row.note?.trim() || undefined, row.spotify_url ?? undefined]
            .filter(Boolean)
            .join("\n\n");
          // A finding's home is its own /log page (the citation surface the archive
          // owns). Fall back to Spotify only when no coordinate has been minted yet.
          const url = row.log_id ? logPageUrl(row.log_id) : (row.spotify_url ?? siteUrl);
          // A mixtape's cover renders on the fly from its Log ID; a finding carries
          // its album cover.
          const image =
            row.item_type === "mixtape"
              ? row.log_id
                ? mixtapeCoverUrl(row.log_id)
                : undefined
              : (row.album_image_url ?? undefined);

          const item: {
            content_text: string;
            date_published: string;
            id: string;
            image?: string;
            tags?: string[];
            title: string;
            url: string;
          } = {
            content_text: contentText,
            date_published: new Date(row.added_at).toISOString(),
            // JSON Feed 1.1: `id` is unique and ideally the permalink URL.
            id: url,
            title,
            url,
          };
          if (image) {
            item.image = image;
          }
          if (row.item_type === "mixtape") {
            item.tags = ["mixtape"];
          }
          return item;
        });

        const feed = {
          description: "Drum & bass bangers from another dimension.",
          favicon: faviconUrl,
          feed_url: "https://www.fluncle.com/feed.json",
          home_page_url: "https://www.fluncle.com",
          icon: coverUrl,
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
