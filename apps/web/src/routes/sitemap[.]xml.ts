import { createFileRoute } from "@tanstack/react-router";
import { siteUrl } from "../lib/fluncle-links";
import { getDb } from "../lib/server/db";

// The sitemap enumerates every log page (one <loc> per coordinate-bearing
// finding) plus the handful of static surfaces. lastmod is REAL: per-finding
// coalesce(updated_at, added_at), never a build stamp.

type LogPageRow = {
  lastmod: string;
  log_id: string;
};

function urlEntry(loc: string, lastmod?: string): string {
  const lastmodTag = lastmod ? `\n    <lastmod>${new Date(lastmod).toISOString()}</lastmod>` : "";

  return `  <url>\n    <loc>${loc}</loc>${lastmodTag}\n  </url>`;
}

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () => {
        const db = await getDb();
        const result = await db.execute({
          sql: `select log_id, coalesce(updated_at, added_at) as lastmod
                from tracks
                where log_id is not null
                order by added_at desc`,
        });
        const rows = result.rows as unknown as LogPageRow[];
        const latest = rows
          .map((row) => row.lastmod)
          .sort()
          .at(-1);

        const entries = [
          urlEntry(`${siteUrl}/`, latest),
          urlEntry(`${siteUrl}/log`, latest),
          urlEntry(`${siteUrl}/about`),
          urlEntry(`${siteUrl}/galaxy`),
          ...rows.map((row) =>
            urlEntry(`${siteUrl}/log/${encodeURIComponent(row.log_id)}`, row.lastmod),
          ),
        ];

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join("\n")}
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
