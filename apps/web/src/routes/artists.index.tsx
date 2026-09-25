import { Link, createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { Button } from "@fluncle/ui/components/button";
import { ArtistAvatar } from "@/components/artist-avatar";
import { CataloguePager } from "@/components/catalogue-groups";
import { HubLetterLane } from "@/components/catalogue-hub-section";
import { HubFooter } from "@/components/hub-footer";
import { HubOrderSwitch, HubThisMonth, HubTile } from "@/components/hub-sections";
import { HubSearchInput } from "@/components/hub-search-input";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { siteUrl } from "@/lib/fluncle-links";
import { tracksCount } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { albumCoverAtSize, HUB_COVER_TILE_SIZE } from "@/lib/media";
import { type HubOrder, hubHref, hubOrderParam } from "@/lib/hub-order";
import { pageParam, textParam } from "@/lib/search-params";
import {
  type ArtistHubEntry,
  artistNamesBySlugs,
  listArtistsHubPage,
  listArtistsThisMonth,
  artistsHaveRecentActivity,
  listSimilarArtistTiles,
} from "@/lib/server/artists";
import { type CatalogueHubNumberedPage } from "@/lib/server/labels";

const countFormatter = new Intl.NumberFormat("en-US");

const MAX_COMPARE_SLUGS = 6;

type ArtistsFoundData = {
  hub: CatalogueHubNumberedPage<ArtistHubEntry>;
  order: HubOrder;
  page: number;
  recentReady: boolean;
  requestedOrder: HubOrder;
  q: string | undefined;
  status: "found";
  thisMonth: ArtistHubEntry[];
};

type ArtistsSimilarData = {
  names: string[];
  results: ArtistHubEntry[];
  status: "similar";
};

type ArtistsPageData = ArtistsFoundData | ArtistsSimilarData | { status: "missing" };

async function resolveArtistsPage(
  page: number | undefined,
  q: string | undefined,
  order: HubOrder,
): Promise<ArtistsPageData> {
  const requested = page ?? 1;
  const recentReady = await artistsHaveRecentActivity();
  const served: HubOrder = order === "recent" && !recentReady ? "most" : order;
  const withStrip = requested === 1 && q === undefined && served === "most";
  const [hub, thisMonth] = await Promise.all([
    listArtistsHubPage(requested, q, served),
    withStrip ? listArtistsThisMonth() : Promise.resolve([]),
  ]);

  if (requested > hub.pageCount) {
    return { status: "missing" };
  }

  return {
    hub,
    order: served,
    page: requested,
    q,
    recentReady,
    requestedOrder: order,
    status: "found",
    thisMonth,
  };
}

const fetchArtistsPage = createServerFn({ method: "GET" })
  .validator((data: { order?: HubOrder; page?: number; q?: string }) => data)
  .handler(
    ({ data }): Promise<ArtistsPageData> =>
      resolveArtistsPage(data.page, data.q, data.order ?? "most"),
  );

function parseCompareSlugs(like: string): string[] {
  return [
    ...new Set(
      like
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].slice(0, MAX_COMPARE_SLUGS);
}

const fetchSimilarArtists = createServerFn({ method: "GET" })
  .validator((data: { like: string }) => data)
  .handler(async ({ data }): Promise<{ names: string[]; results: ArtistHubEntry[] }> => {
    const slugs = parseCompareSlugs(data.like);

    if (slugs.length === 0) {
      return { names: [], results: [] };
    }

    const [names, results] = await Promise.all([
      artistNamesBySlugs(slugs),
      listSimilarArtistTiles(slugs),
    ]);

    return { names, results };
  });

const title = "Every drum & bass artist · Fluncle";
const description =
  "Every drum & bass artist Fluncle holds, with the labels that pressed their records.";

function pagedMeta(page: number): { description: string; title: string } {
  if (page <= 1) {
    return { description, title };
  }

  return {
    description: `Page ${page} of every drum & bass artist Fluncle holds.`,
    title: `Every drum & bass artist, page ${page} · Fluncle`,
  };
}

function metaTagsFor(canonical: string, meta: { description: string; title: string }) {
  const ogImage = `${siteUrl}/api/og/hub?hub=artists`;

  return [
    { title: meta.title },
    { content: meta.description, name: "description" },
    { content: meta.title, property: "og:title" },
    { content: meta.description, property: "og:description" },
    { content: ogImage, property: "og:image" },
    { content: "1200", property: "og:image:width" },
    { content: "630", property: "og:image:height" },
    { content: "image/png", property: "og:image:type" },
    { content: canonical, property: "og:url" },
    { content: "summary_large_image", name: "twitter:card" },
    { content: meta.title, name: "twitter:title" },
    { content: meta.description, name: "twitter:description" },
    { content: ogImage, name: "twitter:image" },
  ];
}

function artistsHead(loaderData: ArtistsPageData | undefined) {
  if (loaderData === undefined || loaderData.status === "missing") {
    return {};
  }

  if (loaderData.status === "similar") {
    const canonical = `${siteUrl}/artists`;
    const metaTags = metaTagsFor(canonical, pagedMeta(1));
    metaTags.push({ content: "noindex, follow", name: "robots" });

    return { links: [{ href: canonical, rel: "canonical" }], meta: metaTags };
  }

  const filtered = loaderData.q !== undefined || loaderData.requestedOrder !== "most";
  const canonical =
    filtered || loaderData.page <= 1
      ? `${siteUrl}/artists`
      : `${siteUrl}/artists?page=${loaderData.page}`;
  const metaTags = metaTagsFor(canonical, pagedMeta(filtered ? 1 : loaderData.page));

  if (filtered) {
    metaTags.push({ content: "noindex, follow", name: "robots" });

    return { links: [{ href: canonical, rel: "canonical" }], meta: metaTags };
  }

  const artists = loaderData.hub.items;
  const collectionPage = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    mainEntity: {
      "@type": "ItemList",
      itemListElement: artists.map((artist, index) => ({
        "@type": "ListItem",
        name: artist.name,
        position: index + 1,
        url: `${siteUrl}/artist/${encodeURIComponent(artist.slug)}`,
      })),
      numberOfItems: loaderData.hub.total,
    },
    name: "Every drum & bass artist Fluncle holds",
    url: `${siteUrl}/artists`,
  };

  return {
    links: [{ href: canonical, rel: "canonical" }],
    meta: metaTags,
    scripts: [jsonLdScript(collectionPage)],
  };
}

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/artists/")({
  validateSearch: (search: Record<string, unknown>): ArtistsSearch => ({
    like: textParam(search["like"]),
    order: hubOrderParam(search["order"]),
    page: pageParam(search["page"]),
    q: textParam(search["q"]),
  }),
  loaderDeps: ({ search }) => ({
    like: search.like,
    order: search.order,
    page: search.page,
    q: search.q,
  }),
  loader: async ({ deps }): Promise<ArtistsPageData> => {
    if (deps.like !== undefined && parseCompareSlugs(deps.like).length >= 2) {
      const data = await fetchSimilarArtists({ data: { like: deps.like } });

      return { names: data.names, results: data.results, status: "similar" };
    }

    const data = await fetchArtistsPage({
      data: { order: deps.order, page: deps.page, q: deps.q },
    });

    if (data.status === "missing") {
      throw notFound();
    }

    return data;
  },
  head: ({ loaderData }: { loaderData?: ArtistsPageData }) => artistsHead(loaderData),
  component: ArtistsPage,
  notFoundComponent: StoryNotFoundState,
});

type ArtistsSearch = { like?: string; order?: "az" | "recent"; page?: number; q?: string };

function mastheadLine(total: number): string {
  return total > 1
    ? `${countFormatter.format(total)} drum & bass artists.`
    : "Drum & bass artists.";
}

function matchCount(count: number): string {
  return `${countFormatter.format(count)} ${count === 1 ? "match" : "matches"}`;
}

function ArtistTileContent({ artist }: { artist: ArtistHubEntry }) {
  return (
    <>
      <ArtistAvatar
        className="artist-card-avatar"
        name={artist.name}
        src={albumCoverAtSize(artist.imageUrl, HUB_COVER_TILE_SIZE)}
      />
      <span className="artist-grid-line">{artist.name}</span>
      <span className="artist-grid-count">{tracksCount(artist.trackCount)}</span>
    </>
  );
}

function ArtistLinkTile({ artist }: { artist: ArtistHubEntry }) {
  return (
    <HubTile kind="artist" lit={artist.certified} name={artist.name} round slug={artist.slug}>
      <Link
        className={artist.certified ? "hub-tile-certified" : undefined}
        params={{ slug: artist.slug }}
        to="/artist/$slug"
      >
        <ArtistTileContent artist={artist} />
      </Link>
    </HubTile>
  );
}

function ArtistsBrowseGrid({ artists }: { artists: ArtistHubEntry[] }) {
  const navigate = useNavigate();
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const compareButtonRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const didMount = useRef(false);

  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;

      return;
    }

    (selecting ? cancelButtonRef.current : compareButtonRef.current)?.focus();
  }, [selecting]);

  const atCap = selected.length >= MAX_COMPARE_SLUGS;

  const toggle = (slug: string) =>
    setSelected((prev) => {
      if (prev.includes(slug)) {
        return prev.filter((value) => value !== slug);
      }

      return prev.length >= MAX_COMPARE_SLUGS ? prev : [...prev, slug];
    });

  const exit = () => {
    setSelecting(false);
    setSelected([]);
  };

  const compare = () => {
    if (selected.length >= 2) {
      void navigate({ search: { like: selected.join(",") }, to: "/artists" });
    }
  };

  const hint =
    selected.length < 2 ? "Pick two to six artists to compare." : `${selected.length} selected.`;

  return (
    <>
      <div className="hub-compare-bar">
        <span aria-live="polite" className="hub-compare-hint">
          {selecting ? hint : "Pick two to six artists to see who sounds closest to them."}
        </span>
        {selecting ? (
          <>
            <Button onClick={exit} ref={cancelButtonRef} size="sm" type="button" variant="ghost">
              Cancel
            </Button>
            <Button disabled={selected.length < 2} onClick={compare} size="sm" type="button">
              Sounds like these
            </Button>
          </>
        ) : (
          <Button
            onClick={() => setSelecting(true)}
            ref={compareButtonRef}
            size="sm"
            type="button"
            variant="ghost"
          >
            Compare sounds
          </Button>
        )}
      </div>

      <ul aria-label="Artists" className="artist-avatar-grid hub-grid">
        {artists.map((artist) => {
          const isSelected = selected.includes(artist.slug);

          return selecting ? (
            <li key={artist.slug}>
              <button
                aria-pressed={isSelected}
                className={`hub-tile-select${artist.certified ? " hub-tile-certified" : ""}`}
                disabled={atCap && !isSelected}
                onClick={() => toggle(artist.slug)}
                type="button"
              >
                <ArtistTileContent artist={artist} />
              </button>
            </li>
          ) : (
            <ArtistLinkTile artist={artist} key={artist.slug} />
          );
        })}
      </ul>
    </>
  );
}

function namesToPhrase(names: string[]): string {
  if (names.length <= 1) {
    return names[0] ?? "";
  }

  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function ArtistsSimilarView({ names, results }: { names: string[]; results: ArtistHubEntry[] }) {
  const intro =
    names.length > 0
      ? `Closest in sound to ${namesToPhrase(names)}.`
      : "Drum & bass artists, closest in sound first.";

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <h1 className="log-coordinate log-index-title">Artists</h1>
          <p className="log-index-intro">{intro}</p>
        </header>

        {results.length === 0 ? (
          <p className="log-index-empty empty-scanlines">No close matches yet.</p>
        ) : (
          <ul
            aria-label="Artists that sound alike"
            className="artist-avatar-grid hub-grid"
            data-discovery="similar"
          >
            {results.map((artist) => (
              <ArtistLinkTile artist={artist} key={artist.slug} />
            ))}
          </ul>
        )}

        <HubFooter />
      </article>
    </main>
  );
}

function ArtistsPage() {
  const data = Route.useLoaderData();
  const navigate = useNavigate();

  if (data.status === "missing") {
    return null;
  }

  if (data.status === "similar") {
    return <ArtistsSimilarView names={data.names} results={data.results} />;
  }

  const { hub, order, q, thisMonth } = data;
  const filtered = q !== undefined;
  const buildHref = (page: number) => hubHref("/artists", { order, page, q });
  const showSearch = filtered || hub.total > 0;
  const setOrder = (next: HubOrder) =>
    void navigate({ search: { order: hubOrderParam(next), q }, to: "/artists" });

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <h1 className="log-coordinate log-index-title">Artists</h1>
          <p className="log-index-intro">{mastheadLine(filtered ? 0 : hub.total)}</p>
        </header>

        {showSearch ? (
          <HubSearchInput
            label="Search artists by name"
            onSearch={(term) =>
              void navigate({ search: { order: hubOrderParam(order), q: term }, to: "/artists" })
            }
            placeholder="Search artists"
            value={q}
          />
        ) : undefined}

        {filtered ? (
          <p aria-live="polite" className="tracks-hub-matchline">
            {matchCount(hub.total)}
          </p>
        ) : undefined}

        <HubThisMonth count={thisMonth.length} label="Artists with a record out this month">
          {thisMonth.map((artist) => (
            <ArtistLinkTile artist={artist} key={artist.slug} />
          ))}
        </HubThisMonth>

        {hub.items.length === 0 ? (
          <p className="log-index-empty empty-scanlines">
            {filtered ? "No artists match that name." : "No drum & bass artists yet."}
          </p>
        ) : (
          <>
            <h2 className="sr-only">Every artist</h2>
            <HubOrderSwitch onChange={setOrder} order={order} recentReady={data.recentReady} />
            {filtered || order !== "az" ? undefined : (
              <HubLetterLane
                buildHref={buildHref}
                label="Artists A to Z"
                letters={hub.letters ?? []}
              />
            )}
            <ArtistsBrowseGrid artists={hub.items} />
            <CataloguePager
              buildHref={buildHref}
              label="Artists, more pages"
              page={hub.page}
              pageCount={hub.pageCount}
            />
          </>
        )}

        <HubFooter current="/artists" />
      </article>
    </main>
  );
}
