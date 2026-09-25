import { createFileRoute } from "@tanstack/react-router";
import { buildSitemapIndexXml } from "../lib/sitemap";
import { collectSitemapIndexStats, SITEMAP_HEADERS } from "../lib/server/sitemap-data";

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () => {
        const stats = await collectSitemapIndexStats();

        return new Response(buildSitemapIndexXml(stats), { headers: SITEMAP_HEADERS });
      },
    },
  },
});
