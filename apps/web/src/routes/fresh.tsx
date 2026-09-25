import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { FreshPageView } from "@/components/fresh";
import { freshIntro } from "@/components/fresh/copy";
import { siteUrl } from "@/lib/fluncle-links";
import {
  type FreshPage,
  type FreshView,
  groupFreshReleases,
  releaseTrack,
} from "@/lib/fresh-releases";
import { jsonLdScript } from "@/lib/json-ld";
import { logPageUrl } from "@/lib/log-schema";
import { listFreshReleases } from "@/lib/server/fresh";
import { releaseTodayUtc } from "@/lib/server/release-day";

// `/fresh` — WHAT JUST CAME OUT, across the whole archive: a FINITE WEEK.
//
// The page answers one query ("new drum & bass releases") the way a weekly listener asks it: what
// came out this week, then last week, back to the end of a trailing 30-day window, and then it says
// so. It is a CATALOGUE page (DESIGN.md's Three Areas Rule): the shared plate, the title alone, one
// factual intro line. Always indexable, like /albums or /artists; SEO is the whole point.
//
// The unit is the RELEASE, not the track: one EP is one entry whose tracks fold out beneath it, and
// the releases sit in rolling week buckets with their counts (`lib/fresh-releases.ts`, folded on the
// server so the payload carries each record's cover once). A finding is lit and an uncertified row
// unlit, by the light alone (the Unlit Rule). The copy never claims Fluncle FOUND these: these are
// RELEASE dates, and the two are unrelated (lib/server/fresh.ts; VOICE.md's Found Rule).

// The same read the feeds make (`listFreshTracks` folds the same rows), so /fresh.xml and
// /fresh.json can never list a track the page does not.
const fetchFresh = createServerFn({ method: "GET" }).handler(async (): Promise<FreshPage> => {
  const now = new Date();

  return groupFreshReleases(await listFreshReleases(now), releaseTodayUtc(now));
});

const title = "New drum & bass releases · Fluncle";
const description =
  "The newest drum & bass releases from the last 30 days, with the artists behind them.";

/**
 * The page's JSON-LD: an `ItemList` of the rendered tracks as `MusicRecording`s, bounded to what
 * the page actually shows (the read is already capped). A finding resolves to its `/log`
 * coordinate; an uncertified row to its off-site URL, or to none — only a finding is ever given a
 * fluncle.com URL, so the structured data never claims a certification that does not exist. The
 * whole payload is HTML-escaped by `jsonLdScript` before it reaches the inline <script> (a
 * `</script>` in a Spotify-sourced title can't break out — the stored-XSS sink).
 *
 * THE VIEW-PILL CHOICE: this list is STABLE across the `?view=` pills. The canonical URL is bare
 * `/fresh` for every view, and its default ("All") holds every track of every release in the window,
 * so the structured data describes the canonical page a crawler sees, never a client-side filter.
 */
function freshItemList(page: FreshPage): Record<string, unknown> {
  const entries = page.weeks.flatMap((week) =>
    week.releases.flatMap((release) =>
      release.tracks.map((track) => ({
        artists: releaseTrack(release, track).artists.map((artist) => artist.name),
        releaseDate: release.releaseDate,
        title: track.title,
        url: track.lit && track.logId ? logPageUrl(track.logId) : track.spotifyUrl,
      })),
    ),
  );

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
        // `datePublished`.
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

function freshHead(loaderData: FreshPage | undefined) {
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
  loader: (): Promise<FreshPage> => fetchFresh(),
  head: ({ loaderData }: { loaderData?: FreshPage }) => freshHead(loaderData),
  component: FreshRoute,
});

function FreshRoute() {
  const page = Route.useLoaderData();
  const { view: viewParam } = Route.useSearch();
  const navigate = useNavigate();

  const view: FreshView = viewParam ?? "all";

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
    <main className="log-plate-stage">
      <article className="log-plate log-index fresh-plate">
        <header className="log-masthead">
          <h1 className="log-coordinate log-index-title">Fresh</h1>
          {/* Catalogue register (VOICE.md's Three Areas): one factual line, the release count and
              the stretch it covers. ONE composed string, so SSR never splits it into text nodes. */}
          <p className="log-index-intro">{freshIntro(page)}</p>
        </header>

        <FreshPageView onViewChange={onViewChange} page={page} view={view} />

        <footer className="log-plate-footer">
          <Link to="/findings">Back to the archive</Link>
          <Link to="/tracks">Tracks</Link>
        </footer>
      </article>
    </main>
  );
}
