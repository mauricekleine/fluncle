import { createFileRoute } from "@tanstack/react-router";
import { logPageUrl, siteUrl } from "../lib/fluncle-links";
import { type FreshTrack, listFreshTracks } from "../lib/server/fresh";

// The release-date sibling of /feed.json. That feed keys on findings.added_at — WHEN Fluncle
// found a tune. This one keys on tracks.release_date — when the tune came OUT — so its dates
// are RELEASE dates and its copy never says he "found" these, only that they just landed
// (VOICE.md's Found Rule). It reuses the ratified /fresh page title + line verbatim.
//
// Two tiers ride the same list. A CERTIFIED finding carries its Log ID coordinate + cover, so
// it links to its /log home and shows its art. An UNCERTIFIED catalogue row carries neither
// (structurally — listFreshTracks only hands over logId/coverImageUrl when certified), so it
// links OUT to Spotify and renders unlit: no /log, no coordinate, no cover (DESIGN.md's Unlit
// Rule). A row with neither coordinate nor Spotify has no `url`, only a deterministic `id`.

// The feed-level icon (site cover) + favicon, the images other pages fall back to.
const coverUrl = `${siteUrl}/fluncle-cover.png`;
const faviconUrl = `${siteUrl}/favicon.png`;

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
 * is nowhere honest to point.
 */
function itemLink(track: FreshTrack): string | undefined {
  if (track.certified && track.logId) {
    return logPageUrl(track.logId);
  }
  return track.spotifyUrl;
}

/** A stable, unique id: the permalink when one exists, else a deterministic release urn (an
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

export const Route = createFileRoute("/fresh.json")({
  server: {
    handlers: {
      GET: async () => {
        const { tracks } = await listFreshTracks({ limit: 50 });

        const items = tracks.map((track) => {
          const title = itemTitle(track);
          const link = itemLink(track);
          // Keep the Spotify link reachable in the body even when it is not the item url (a
          // certified finding links to /log instead).
          const contentText = [title, track.spotifyUrl ?? undefined].filter(Boolean).join("\n\n");
          const published = releaseInstant(track.releaseDate);

          const item: {
            content_text: string;
            date_published?: string;
            id: string;
            image?: string;
            title: string;
            url?: string;
          } = {
            content_text: contentText,
            // JSON Feed 1.1: `id` is unique and ideally the permalink URL.
            id: itemId(track, link),
            title,
          };
          if (link) {
            item.url = link;
          }
          if (published) {
            item.date_published = published.toISOString();
          }
          // Only a certified finding carries a cover; an uncertified row stays unlit.
          if (track.coverImageUrl) {
            item.image = track.coverImageUrl;
          }
          return item;
        });

        const feed = {
          description: channelDescription,
          favicon: faviconUrl,
          feed_url: "https://www.fluncle.com/fresh.json",
          home_page_url: "https://www.fluncle.com/fresh",
          icon: coverUrl,
          items,
          title: channelTitle,
          version: "https://jsonfeed.org/version/1.1",
        };

        return new Response(JSON.stringify(feed), {
          headers: {
            // Readers get a short max-age; the CDN holds s-maxage; SWR keeps
            // every repeat poll free while a background refresh runs.
            "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
            "Content-Type": "application/feed+json; charset=utf-8",
          },
        });
      },
    },
  },
});
