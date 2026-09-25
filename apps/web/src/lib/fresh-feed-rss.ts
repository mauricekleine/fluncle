import { escapeXml } from "./feed-xml";
import { siteUrl } from "./fluncle-links";
import { itemId, itemLink, itemTitle, releaseInstant } from "./fresh-feed-item";
import { type FreshTrack } from "./server/fresh";

const coverUrl = `${siteUrl}/fluncle-cover.png`;

export type FreshFeedKind = "artist" | "label";

export function entityFreshChannel(
  kind: FreshFeedKind,
  name: string,
): { description: string; title: string } {
  return kind === "artist"
    ? {
        description: `The freshest from ${name}, hot off the press. Every release from the last 30 days, tracked as Fluncle spins his way through them.`,
        title: `New ${name} releases · Fluncle`,
      }
    : {
        description: `The freshest on ${name}, hot off the press. Every release from the last 30 days, tracked as Fluncle spins his way through them.`,
        title: `New releases on ${name} · Fluncle`,
      };
}

export function renderEntityFreshFeed(options: {
  description: string;
  link: string;
  title: string;
  tracks: FreshTrack[];
}): string {
  const { description, link, title, tracks } = options;
  const newest = tracks[0]?.releaseDate;
  const newestInstant = newest ? releaseInstant(newest) : undefined;

  const items = tracks.map((track) => {
    const itemTitleText = itemTitle(track);
    const itemLinkUrl = itemLink(track);

    const itemDescription = [itemTitleText, track.spotifyUrl ?? undefined]
      .filter(Boolean)
      .join("\n\n");
    const published = releaseInstant(track.releaseDate);

    const imageUrl = track.coverImageUrl;

    return `<item>
  <title>${escapeXml(itemTitleText)}</title>
  ${itemLinkUrl ? `<link>${escapeXml(itemLinkUrl)}</link>` : ""}
  <guid isPermaLink="false">${escapeXml(itemId(track, itemLinkUrl))}</guid>
  ${published ? `<pubDate>${published.toUTCString()}</pubDate>` : ""}
  ${imageUrl ? `<media:content url="${escapeXml(imageUrl)}" medium="image"/>` : ""}
  <description>${escapeXml(itemDescription)}</description>
</item>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
  <title>${escapeXml(title)}</title>
  <link>${escapeXml(link)}</link>
  <description>${escapeXml(description)}</description>
  <image>
    <url>${escapeXml(coverUrl)}</url>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(link)}</link>
  </image>
  ${newestInstant ? `<lastBuildDate>${newestInstant.toUTCString()}</lastBuildDate>` : ""}
${items.join("\n")}
</channel>
</rss>`;
}

export function freshFeedResponse(xml: string, cacheControl: string): Response {
  return new Response(xml, {
    headers: {
      "Cache-Control": cacheControl,
      "Content-Type": "application/rss+xml; charset=utf-8",

      "X-Robots-Tag": "noindex",
    },
  });
}
