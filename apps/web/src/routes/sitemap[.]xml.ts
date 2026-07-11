import { createFileRoute } from "@tanstack/react-router";
import { buildSitemapIndexXml } from "../lib/sitemap";
import { collectSitemapBags, SITEMAP_HEADERS } from "../lib/server/sitemap-data";

// `/sitemap.xml` — the INDEX. It carries no `<url>` of its own; it points at the children
// (`/sitemap/<kind>-<n>.xml`), each auto-paged under Google's 50,000-URL / 50 MB ceiling so
// a breach cannot happen rather than merely not having happened yet. See lib/sitemap.ts for
// why, and robots.txt (which still names this one URL — a crawler discovers the children
// from here).

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () => {
        const bags = await collectSitemapBags();

        return new Response(buildSitemapIndexXml(bags), { headers: SITEMAP_HEADERS });
      },
    },
  },
});
