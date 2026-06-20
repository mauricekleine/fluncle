import { siteUrl } from "./fluncle-links";

// The sitemap document, pure: the route feeds it rows; lastmod is REAL
// (per-finding coalesce(updated_at, added_at) from the query), never a build
// stamp — entries without a known date simply omit the tag.

export type SitemapLogPage = {
  /** ISO date of the finding's last real content change. */
  lastmod: string;
  logId: string;
};

function urlEntry(loc: string, lastmod?: string): string {
  const lastmodTag = lastmod ? `\n    <lastmod>${new Date(lastmod).toISOString()}</lastmod>` : "";

  return `  <url>\n    <loc>${loc}</loc>${lastmodTag}\n  </url>`;
}

export function buildSitemapXml(logPages: SitemapLogPage[]): string {
  const latest = logPages
    .map((page) => page.lastmod)
    .sort()
    .at(-1);

  const entries = [
    urlEntry(`${siteUrl}/`, latest),
    urlEntry(`${siteUrl}/log`, latest),
    urlEntry(`${siteUrl}/mixtapes`, latest),
    urlEntry(`${siteUrl}/about`),
    urlEntry(`${siteUrl}/privacy`),
    urlEntry(`${siteUrl}/galaxy`),
    ...logPages.map((page) =>
      urlEntry(`${siteUrl}/log/${encodeURIComponent(page.logId)}`, page.lastmod),
    ),
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join("\n")}
</urlset>`;
}
