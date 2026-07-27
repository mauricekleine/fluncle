import { createFileRoute } from "@tanstack/react-router";
import { buildSitemapIndexXml } from "../lib/sitemap";
import { collectSitemapIndexStats, SITEMAP_HEADERS } from "../lib/server/sitemap-data";

// `/sitemap.xml` — the INDEX. It carries no `<url>` of its own; it points at the children
// (`/sitemap/<kind>-<n>.xml`), each auto-paged under Google's 50,000-URL / 50 MB ceiling so
// a breach cannot happen rather than merely not having happened yet. See lib/sitemap.ts for
// why, and robots.txt (which still names this one URL — a crawler discovers the children
// from here).
//
// Because it carries no `<url>`, it reads no URLs: `collectSitemapIndexStats` answers each child's
// SIZE and DATE with a `count(*)` and a `max()`. This document is also edge-cached for an hour
// (server.ts → SITEMAP_CACHE_POLICY), so a crawl storm collapses onto one read.

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
