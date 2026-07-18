import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { FreshEmpty, FreshFooter, FreshMarquee } from "@/components/fresh";
import { siteUrl } from "@/lib/fluncle-links";
import { jsonLdScript } from "@/lib/json-ld";
import { logPageUrl } from "@/lib/log-schema";
import { type FreshReleases, listFreshReleases } from "@/lib/server/fresh";

// `/fresh` — WHAT JUST CAME OUT, across the whole archive.
//
// The page answers one query ("new drum & bass releases") the way a crate digger asks it: newest
// first, the whole frontier, over a trailing 30-day window. It is a HUB, not a detail page — always
// indexable, like /albums or /artists; SEO is the whole point. Unlike the wiki-style graph pages
// (artist/label/album), which sit on the reading plate, /fresh is always-evolving and gets its own
// full-bleed treatment — the MARQUEE (components/fresh/): a billboard of the newest drops.
//
// A finding leads in full voice (avatar + Log ID coordinate, gold heat); an uncertified row follows
// in the unlit register — a dimmed avatar, no coordinate (DESIGN.md's Unlit Rule); an album record
// leads with its cover and links to its page. The copy is careful never to claim Fluncle FOUND
// these: these are RELEASE dates, and the two are unrelated (lib/server/fresh.ts; VOICE.md's Found
// Rule).

const fetchFresh = createServerFn({ method: "GET" }).handler(
  (): Promise<FreshReleases> => listFreshReleases(),
);

const title = "New drum & bass releases · Fluncle";
const description =
  "The freshest drum & bass, hot off the press. Every release from the last 30 days, tracked as Fluncle spins his way through them.";

/**
 * The page's JSON-LD: an `ItemList` of the rendered tracks as `MusicRecording`s, bounded to what
 * the page actually shows (the loader is already capped). A finding resolves to its `/log`
 * coordinate; an uncertified row to its off-site URL, or to none — only a finding is ever given a
 * fluncle.com URL, so the structured data never claims a certification that does not exist. The
 * whole payload is HTML-escaped by `jsonLdScript` before it reaches the inline <script> (a
 * `</script>` in a Spotify-sourced title can't break out — the stored-XSS sink).
 */
function freshItemList(data: FreshReleases): Record<string, unknown> {
  type Entry = { artists: string[]; title: string; url?: string };
  const entries: Entry[] = data.sections.flatMap((section) => [
    ...section.findings.flatMap((finding) =>
      finding.logId
        ? [{ artists: finding.artists, title: finding.title, url: logPageUrl(finding.logId) }]
        : [],
    ),
    ...section.catalogue.map((track) => ({
      artists: track.artists,
      title: track.title,
      url: track.spotifyUrl,
    })),
  ]);

  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: entries.map((entry, index) => ({
      "@type": "ListItem",
      item: {
        "@type": "MusicRecording",
        byArtist: entry.artists.map((name) => ({ "@type": "MusicGroup", name })),
        genre: "Drum and Bass",
        name: entry.title,
        ...(entry.url ? { url: entry.url } : {}),
      },
      position: index + 1,
    })),
    name: "New drum & bass releases",
    url: `${siteUrl}/fresh`,
  };
}

function freshHead(loaderData: FreshReleases | undefined) {
  const pageUrl = `${siteUrl}/fresh`;

  return {
    links: [{ href: pageUrl, rel: "canonical" }],
    meta: [
      { title },
      { content: description, name: "description" },
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: `${siteUrl}/fluncle-cover.png`, property: "og:image" },
      { content: pageUrl, property: "og:url" },
      { content: "summary_large_image", name: "twitter:card" },
      { content: title, name: "twitter:title" },
      { content: description, name: "twitter:description" },
    ],
    scripts: loaderData ? [jsonLdScript(freshItemList(loaderData))] : [],
  };
}

// Route options follow TanStack's create-route-property-order (each step feeds the next's
// inferred types), which isn't alphabetical — so sort-keys is off here.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/fresh")({
  loader: (): Promise<FreshReleases> => fetchFresh(),
  head: ({ loaderData }: { loaderData?: FreshReleases }) => freshHead(loaderData),
  component: FreshPage,
});

function FreshPage() {
  const data = Route.useLoaderData();
  const empty = data.sections.length === 0 && data.records.length === 0;

  return (
    <main className="fresh-page">
      {empty ? <FreshEmpty windowDays={data.windowDays} /> : <FreshMarquee data={data} />}
      <FreshFooter />
    </main>
  );
}
