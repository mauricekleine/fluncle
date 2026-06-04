import { createFileRoute } from "@tanstack/react-router";
import { siteUrl } from "../lib/fluncle-links";
import { getDb } from "../lib/server/db";

type LatestRow = {
  latest_added_at: string | null;
};

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () => {
        const db = await getDb();
        const result = await db.execute({
          sql: `select max(added_at) as latest_added_at from tracks`,
        });
        const rows = result.rows as unknown as LatestRow[];
        const latestAddedAt = rows[0]?.latest_added_at;
        const lastmod = latestAddedAt
          ? `\n    <lastmod>${new Date(latestAddedAt).toISOString()}</lastmod>`
          : "";
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${siteUrl}/</loc>${lastmod}
  </url>
</urlset>`;

        return new Response(xml, {
          headers: {
            "Content-Type": "application/xml; charset=utf-8",
          },
        });
      },
    },
  },
});
