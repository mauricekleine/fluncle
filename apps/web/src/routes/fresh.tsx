import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { FreshEmpty, FreshFooter, FreshMarquee } from "@/components/fresh";
import { type FreshView } from "@/components/fresh/data";
import { siteUrl } from "@/lib/fluncle-links";
import { jsonLdScript } from "@/lib/json-ld";
import { logPageUrl } from "@/lib/log-schema";
import {
  FRESH_RECORDS_WINDOW_DAYS,
  type FreshReleases,
  listFreshReleases,
} from "@/lib/server/fresh";

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

// The page reaches the WIDER records window (90 days) so its "Albums & EPs" view has a full album
// cut; the track stream inside stays on the 30-day window, and every feed is untouched (they call
// `listFreshTracks`, which reads the default window). The "All" view's rail narrows the records back
// to the 30-day cut client-side, so the default layout is unchanged.
const fetchFresh = createServerFn({ method: "GET" }).handler(
  (): Promise<FreshReleases> => listFreshReleases(new Date(), FRESH_RECORDS_WINDOW_DAYS),
);

const title = "New drum & bass releases · Fluncle";
const description =
  "The newest drum & bass releases from the last 30 days, with the artists behind them.";

/**
 * The page's JSON-LD: an `ItemList` of the rendered tracks as `MusicRecording`s, bounded to what
 * the page actually shows (the loader is already capped). A finding resolves to its `/log`
 * coordinate; an uncertified row to its off-site URL, or to none — only a finding is ever given a
 * fluncle.com URL, so the structured data never claims a certification that does not exist. The
 * whole payload is HTML-escaped by `jsonLdScript` before it reaches the inline <script> (a
 * `</script>` in a Spotify-sourced title can't break out — the stored-XSS sink).
 *
 * THE VIEW-PILL CHOICE: this list is STABLE across the `?view=` pills. The canonical URL is bare
 * `/fresh` for every view, and its default ("All") renders exactly this 30-day track stream — so the
 * structured data describes the canonical page a crawler sees, never a client-side filter of it. It
 * lists the track stream only (never the wider 90-day album cut), so it can never claim more than the
 * canonical page shows; the album records carry their own `/album/<slug>` schema elsewhere.
 */
function freshItemList(data: FreshReleases): Record<string, unknown> {
  type Entry = { artists: string[]; releaseDate?: string; title: string; url?: string };
  const entries: Entry[] = data.sections.flatMap((section) => [
    ...section.findings.flatMap((finding) =>
      finding.logId
        ? [
            {
              artists: finding.artists,
              releaseDate: finding.releaseDate,
              title: finding.title,
              url: logPageUrl(finding.logId),
            },
          ]
        : [],
    ),
    ...section.catalogue.map((track) => ({
      artists: track.artists,
      // The unlit row's own release date — the whole page is ordered by it, so the structured
      // data carries it too (this IS "what just came out").
      releaseDate: track.releaseDate,
      title: track.title,
      url: track.spotifyUrl,
    })),
  ]);

  // The rendered tracks as an ItemList, riding as the `mainEntity` of a `CollectionPage` (the hub
  // shape the graph indexes now use) with `numberOfItems` so the list's size is machine-readable.
  const itemList = {
    "@type": "ItemList",
    itemListElement: entries.map((entry, index) => ({
      "@type": "ListItem",
      item: {
        "@type": "MusicRecording",
        byArtist: entry.artists.map((name) => ({ "@type": "MusicGroup", name })),
        // The release date — the one fact this page is sorted by — as each recording's
        // `datePublished`. Present on every row (both halves carry a release_date).
        ...(entry.releaseDate ? { datePublished: entry.releaseDate } : {}),
        genre: "Drum and Bass",
        name: entry.title,
        ...(entry.url ? { url: entry.url } : {}),
      },
      position: index + 1,
    })),
    numberOfItems: entries.length,
  };

  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    mainEntity: itemList,
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

/** The view a reader can land on directly (`?view=tracks` / `?view=albums`); anything else — including
    the absent param — is the default "All". Kept OFF the URL when it is the default so the canonical
    stays bare `/fresh` (no indexable filter space) and `all` maps back to an absent param. */
type FreshSearch = { view?: "albums" | "tracks" };

// Route options follow TanStack's create-route-property-order (each step feeds the next's
// inferred types), which isn't alphabetical — so sort-keys is off here.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/fresh")({
  validateSearch: (search: Record<string, unknown>): FreshSearch => ({
    view: search.view === "tracks" || search.view === "albums" ? search.view : undefined,
  }),
  loader: (): Promise<FreshReleases> => fetchFresh(),
  head: ({ loaderData }: { loaderData?: FreshReleases }) => freshHead(loaderData),
  component: FreshPage,
});

function FreshPage() {
  const data = Route.useLoaderData();
  const { view: viewParam } = Route.useSearch();
  const navigate = useNavigate();

  const view: FreshView = viewParam ?? "all";
  const empty = data.sections.length === 0 && data.records.length === 0;

  // The pill writes the view to `?view=`; "all" clears the param, so the default view keeps the URL
  // bare. `replace` keeps a run of pill clicks out of the back-stack; a shared link still deep-links.
  const onViewChange = (next: FreshView): void => {
    void navigate({
      replace: true,
      resetScroll: false,
      search: { view: next === "all" ? undefined : next },
      to: "/fresh",
    });
  };

  return (
    <main className="fresh-page">
      {empty ? (
        <FreshEmpty windowDays={data.windowDays} />
      ) : (
        <FreshMarquee data={data} onViewChange={onViewChange} view={view} />
      )}
      <FreshFooter />
    </main>
  );
}
