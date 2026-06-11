import { createFileRoute } from "@tanstack/react-router";
import { buildSitemapXml } from "../lib/sitemap";
import { getDb } from "../lib/server/db";

// One <loc> per coordinate-bearing finding plus the static surfaces; lastmod
// is the finding's real coalesce(updated_at, added_at) (lib/sitemap.ts).

type LogPageRow = {
  lastmod: string;
  log_id: string;
};

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
        const xml = buildSitemapXml(
          rows.map((row) => ({ lastmod: row.lastmod, logId: row.log_id })),
        );

        return new Response(xml, {
          headers: {
            "Content-Type": "application/xml; charset=utf-8",
          },
        });
      },
    },
  },
});
