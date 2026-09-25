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

const fetchFresh = createServerFn({ method: "GET" }).handler(async (): Promise<FreshPage> => {
  const now = new Date();

  return groupFreshReleases(await listFreshReleases(now), releaseTodayUtc(now));
});

const title = "New drum & bass releases · Fluncle";
const description =
  "The newest drum & bass releases from the last 30 days, with the artists behind them.";

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

  const itemList = {
    "@type": "ItemList",
    itemListElement: entries.map((entry, index) => ({
      "@type": "ListItem",
      item: {
        "@type": "MusicRecording",
        byArtist: entry.artists.map((name) => ({ "@type": "MusicGroup", name })),

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

type FreshSearch = { view?: "albums" | "tracks" };

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
