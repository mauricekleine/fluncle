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
        const items = rows.map((row) => {
          const artists = parseArtistsJson(row.artists_json);
          const title =
            row.item_type === "mixtape" ? row.title : `${artists.join(", ")} - ${row.title}`;
          const contentText = row.note?.trim() ? `${title}\n\n${row.note.trim()}` : title;
          const url =
            row.item_type === "mixtape"
              ? `https://www.fluncle.com/log/${encodeURIComponent(row.track_id)}`
              : (row.spotify_url as string);

          const item: {
            content_text: string;
            date_published: string;
            id: string;
            tags?: string[];
            title: string;
            url: string;
          } = {
            content_text: contentText,
            date_published: new Date(row.added_at).toISOString(),
            id: row.track_id,
            title,
            url,
          };
          if (row.item_type === "mixtape") {
            item.tags = ["mixtape"];
          }
          return item;
        });

        const feed = {
          description: "Drum & bass bangers from another dimension.",
          feed_url: "https://www.fluncle.com/feed.json",
          home_page_url: "https://www.fluncle.com",
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
