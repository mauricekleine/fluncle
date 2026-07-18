// The shared RSS body behind the per-entity fresh feeds (/artist/<slug>/fresh.xml,
// /label/<slug>/fresh.xml). Both routes narrow the whole-archive /fresh read to one entity and then
// render the SAME two-tier RSS: a CERTIFIED finding links to its /log home and shows its cover; an
// UNCERTIFIED catalogue row links OUT to Spotify only, with no /log and no cover (DESIGN.md's Unlit
// Rule); a row with neither points nowhere. Every date is a RELEASE date, never a Found date
// (VOICE.md's Found Rule). This mirrors the whole-archive /fresh.xml item contract verbatim, scoped.

import { escapeXml } from "./feed-xml";
import { logPageUrl, siteUrl } from "./fluncle-links";
import { type FreshTrack } from "./server/fresh";

/** The site cover, reused for the feed-level image. */
const coverUrl = `${siteUrl}/fluncle-cover.png`;

/** The two entity kinds a per-entity fresh feed narrows to. */
export type FreshFeedKind = "artist" | "label";

/**
 * The RSS channel copy for a per-entity fresh feed — release-framed, scoped to the entity name, held
 * close to /fresh.xml's ratified "The freshest …, hot off the press. Every release from the last 30
 * days." line. The name does the work; the copy never claims Fluncle FOUND these (the Found Rule),
 * only that they just landed. An artist reads "New <name> releases"; a label reads "New releases on
 * <name>".
 */
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

/** `Artist, Artist — Title` — the tracklist line every feed leads its item with. */
function itemTitle(track: FreshTrack): string {
  return `${track.artists.join(", ")} — ${track.title}`;
}

/**
 * Where an item points. A certified finding's home is its own /log page (the citation surface the
 * archive owns); an uncertified row has no coordinate, so it links OUT to Spotify only, and a
 * certified straggler with no coordinate yet falls back to Spotify too. `undefined` when there is
 * nowhere honest to point — the item renders as a plain titled row.
 */
function itemLink(track: FreshTrack): string | undefined {
  if (track.certified && track.logId) {
    return logPageUrl(track.logId);
  }
  return track.spotifyUrl;
}

/** A stable, unique guid: the permalink when one exists, else a deterministic release urn (an
    uncertified row has no coordinate to borrow — the Unlit Rule holds even in the id). */
function itemId(track: FreshTrack, link: string | undefined): string {
  return link ?? `urn:fluncle:release:${track.releaseDate}:${encodeURIComponent(itemTitle(track))}`;
}

/** Parse a `YYYY-MM-DD` release date as a UTC day. `undefined` when the value is absent/unparseable. */
function releaseInstant(releaseDate: string): Date | undefined {
  if (!releaseDate) {
    return undefined;
  }
  const parsed = new Date(`${releaseDate}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Render the two-tier RSS 2.0 document for one entity's fresh tracks. */
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
    // Keep the Spotify link reachable in the body even when it is not the item link (a certified
    // finding links to /log instead).
    const itemDescription = [itemTitleText, track.spotifyUrl ?? undefined]
      .filter(Boolean)
      .join("\n\n");
    const published = releaseInstant(track.releaseDate);
    // Only a certified finding carries a cover; an uncertified row stays unlit.
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

/** The cache + content-type headers every fresh feed serves (verbatim from /fresh.xml). */
export function freshFeedResponse(xml: string): Response {
  return new Response(xml, {
    headers: {
      // Readers get a short max-age; the CDN holds s-maxage; SWR keeps every repeat poll free
      // while a background refresh runs.
      "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
      "Content-Type": "application/rss+xml; charset=utf-8",
    },
  });
}
