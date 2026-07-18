import { createFileRoute } from "@tanstack/react-router";
import { escapeXml } from "../lib/feed-xml";
import { logPageUrl, siteUrl } from "../lib/fluncle-links";
import { type FreshTrack, listFreshTracks } from "../lib/server/fresh";

// The release-date sibling of /rss.xml. That feed keys on findings.added_at — WHEN Fluncle
// found a tune. This one keys on tracks.release_date — when the tune came OUT — so its dates
// are RELEASE dates and its copy never says he "found" these, only that they just landed
// (VOICE.md's Found Rule). It reuses the ratified /fresh page title + line verbatim.
//
// Two tiers ride the same list. A CERTIFIED finding carries its Log ID coordinate + cover, so
// it links to its /log home and shows its art. An UNCERTIFIED catalogue row carries neither
// (structurally — listFreshTracks only hands over logId/coverImageUrl when certified), so it
// links OUT to Spotify and renders unlit: no /log, no coordinate, no cover (DESIGN.md's Unlit
// Rule). A row with neither coordinate nor Spotify is a plain titled item, no link.

// The site cover, reused for the feed-level image.
const coverUrl = `${siteUrl}/fluncle-cover.png`;

// Reused verbatim from the /fresh page (apps/web/src/routes/fresh.tsx) — one action, one label.
const channelTitle = "New drum & bass releases · Fluncle";
const channelDescription =
  "The freshest drum & bass, hot off the press. Every release from the last 30 days, tracked as Fluncle spins his way through them.";

/** `Artist, Artist — Title` — the tracklist line every feed leads its item with. */
function itemTitle(track: FreshTrack): string {
  return `${track.artists.join(", ")} — ${track.title}`;
}

/**
 * Where an item points. A certified finding's home is its own /log page (the citation surface
 * the archive owns); an uncertified row has no coordinate, so it links OUT to Spotify only, and
 * a certified straggler with no coordinate yet falls back to Spotify too. `undefined` when there
 * is nowhere honest to point — the item renders as a plain titled row.
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

export const Route = createFileRoute("/fresh.xml")({
  server: {
    handlers: {
      GET: async () => {
        const { tracks } = await listFreshTracks({ limit: 50 });
        const newest = tracks[0]?.releaseDate;
        const newestInstant = newest ? releaseInstant(newest) : undefined;

        const items = tracks.map((track) => {
          const title = itemTitle(track);
          const link = itemLink(track);
          // Keep the Spotify link reachable in the body even when it is not the item link (a
          // certified finding links to /log instead).
          const description = [title, track.spotifyUrl ?? undefined].filter(Boolean).join("\n\n");
          const published = releaseInstant(track.releaseDate);
          // Only a certified finding carries a cover; an uncertified row stays unlit.
          const imageUrl = track.coverImageUrl;

          return `<item>
  <title>${escapeXml(title)}</title>
  ${link ? `<link>${escapeXml(link)}</link>` : ""}
  <guid isPermaLink="false">${escapeXml(itemId(track, link))}</guid>
  ${published ? `<pubDate>${published.toUTCString()}</pubDate>` : ""}
  ${imageUrl ? `<media:content url="${escapeXml(imageUrl)}" medium="image"/>` : ""}
  <description>${escapeXml(description)}</description>
</item>`;
        });

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
  <title>${escapeXml(channelTitle)}</title>
  <link>https://www.fluncle.com/fresh</link>
  <description>${escapeXml(channelDescription)}</description>
  <image>
    <url>${escapeXml(coverUrl)}</url>
    <title>${escapeXml(channelTitle)}</title>
    <link>https://www.fluncle.com/fresh</link>
  </image>
  ${newestInstant ? `<lastBuildDate>${newestInstant.toUTCString()}</lastBuildDate>` : ""}
${items.join("\n")}
</channel>
</rss>`;

        return new Response(xml, {
          headers: {
            // Readers get a short max-age; the CDN holds s-maxage; SWR keeps
            // every repeat poll free while a background refresh runs.
            "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
            "Content-Type": "application/rss+xml; charset=utf-8",
          },
        });
      },
    },
  },
});
