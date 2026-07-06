import { siteUrl } from "./fluncle-links";

// The sitemap document, pure: the route feeds it rows; lastmod is REAL
// (per-finding freshest of video_squared_at / updated_at / added_at from the
// query), never a build stamp — entries without a known date simply omit the tag.
//
// A finding that carries a rendered video also gets a Google video-sitemap
// `<video:video>` block (thumbnail/title/description/content_loc), and every
// finding gets an `<image:image>` (cover art) for Google Images — so the archive
// surfaces its videos and its covers to the right crawlers, not just a plain
// `<loc>`. A malformed video block gets the WHOLE sitemap rejected, so every
// text field is XML-escaped and the field order follows Google's spec exactly.

/** A finding's rendered video, for the `<video:video>` sitemap extension. */
export type SitemapVideo = {
  /** The footage file URL — `<video:content_loc>`. */
  contentLoc: string;
  /** A one-or-two sentence description — `<video:description>` (required). */
  description: string;
  /** The poster/cover still — `<video:thumbnail_loc>` (required). */
  thumbnailLoc: string;
  /** `Artist — Title` — `<video:title>` (required). */
  title: string;
};

export type SitemapLogPage = {
  /** Cover art for the Google Images `<image:image>` extension. */
  imageLoc?: string;
  /** ISO date of the finding's last real content change. */
  lastmod: string;
  logId: string;
  /** Present only when the finding has a rendered video. */
  video?: SitemapVideo;
};

// Escape the five XML metacharacters so a Spotify-sourced title/artist or an
// operator note can't malform the document (a bare `&` invalidates the feed, and
// Google rejects an invalid video sitemap wholesale).
const XML_ESCAPES: Record<string, string> = {
  '"': "&quot;",
  "&": "&amp;",
  "'": "&apos;",
  "<": "&lt;",
  ">": "&gt;",
};

function xmlEscape(value: string): string {
  return value.replace(/["&'<>]/g, (char) => XML_ESCAPES[char] ?? char);
}

function lastmodTag(lastmod?: string): string {
  return lastmod ? `\n    <lastmod>${new Date(lastmod).toISOString()}</lastmod>` : "";
}

// A static-surface entry: just `<loc>` + optional `<lastmod>` (no media).
function staticEntry(loc: string, lastmod?: string): string {
  return `  <url>\n    <loc>${loc}</loc>${lastmodTag(lastmod)}\n  </url>`;
}

// Google video-sitemap required field order: thumbnail_loc, title, description,
// then a player_loc or content_loc. We ship content_loc (the footage file).
function videoTag(video: SitemapVideo): string {
  return [
    "\n    <video:video>",
    `      <video:thumbnail_loc>${xmlEscape(video.thumbnailLoc)}</video:thumbnail_loc>`,
    `      <video:title>${xmlEscape(video.title)}</video:title>`,
    `      <video:description>${xmlEscape(video.description)}</video:description>`,
    `      <video:content_loc>${xmlEscape(video.contentLoc)}</video:content_loc>`,
    "    </video:video>",
  ].join("\n");
}

function imageTag(imageLoc: string): string {
  return `\n    <image:image>\n      <image:loc>${xmlEscape(imageLoc)}</image:loc>\n    </image:image>`;
}

// A finding entry: `<loc>` + `<lastmod>` + optional `<image:image>` + optional
// `<video:video>`. A page with neither media renders exactly like a plain
// static entry (mixtapes flow through here too).
function findingEntry(page: SitemapLogPage): string {
  const loc = `${siteUrl}/log/${encodeURIComponent(page.logId)}`;
  const image = page.imageLoc ? imageTag(page.imageLoc) : "";
  const video = page.video ? videoTag(page.video) : "";

  return `  <url>\n    <loc>${loc}</loc>${lastmodTag(page.lastmod)}${image}${video}\n  </url>`;
}

export function buildSitemapXml(logPages: SitemapLogPage[]): string {
  const latest = logPages
    .map((page) => page.lastmod)
    .sort()
    .at(-1);

  const entries = [
    staticEntry(`${siteUrl}/`, latest),
    staticEntry(`${siteUrl}/log`, latest),
    staticEntry(`${siteUrl}/mixtapes`, latest),
    staticEntry(`${siteUrl}/about`),
    staticEntry(`${siteUrl}/privacy`),
    staticEntry(`${siteUrl}/galaxy`),
    ...logPages.map((page) => findingEntry(page)),
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">
${entries.join("\n")}
</urlset>`;
}
