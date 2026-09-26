import { Link, createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { CataloguePager } from "@/components/catalogue-groups";
import { HubLetterLane } from "@/components/catalogue-hub-section";
import { HubFooter } from "@/components/hub-footer";
import { HubOrderSwitch, HubThisMonth, HubTile } from "@/components/hub-sections";
import { HubSearchInput } from "@/components/hub-search-input";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { TrackArtwork } from "@/components/track-artwork";
import { siteUrl } from "@/lib/fluncle-links";
import { tracksCount } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { albumCoverAtSize, hubCoverSrcSet } from "@/lib/media";
import { type HubOrder, hubHref, hubOrderParam } from "@/lib/hub-order";
import { pageParam, textParam } from "@/lib/search-params";
import {
  albumsHaveRecentActivity,
  type AlbumHubEntry,
  listAlbumsHubPage,
  listAlbumsThisMonth,
} from "@/lib/server/albums";
import { type CatalogueHubNumberedPage } from "@/lib/server/labels";

const countFormatter = new Intl.NumberFormat("en-US");

type AlbumsPageData =
  | {
      hub: CatalogueHubNumberedPage<AlbumHubEntry>;
      order: HubOrder;
      recentReady: boolean;
      requestedOrder: HubOrder;
      page: number;
      q: string | undefined;
      status: "found";
      thisMonth: AlbumHubEntry[];
    }
  | { status: "missing" };

async function resolveAlbumsPage(
  page: number | undefined,
  q: string | undefined,
  order: HubOrder,
): Promise<AlbumsPageData> {
  const requested = page ?? 1;
  const recentReady = await albumsHaveRecentActivity();
  const served: HubOrder = order === "recent" && !recentReady ? "most" : order;
  const withStrip = requested === 1 && q === undefined && served === "most";
  const [hub, thisMonth] = await Promise.all([
    listAlbumsHubPage(requested, q, served),
    withStrip ? listAlbumsThisMonth() : Promise.resolve([]),
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

const fetchAlbumsPage = createServerFn({ method: "GET" })
  .validator((data: { order?: HubOrder; page?: number; q?: string }) => data)
  .handler(
    ({ data }): Promise<AlbumsPageData> =>
      resolveAlbumsPage(data.page, data.q, data.order ?? "most"),
  );

const title = "Every drum & bass album · Fluncle";
const description =
  "Every drum & bass album, EP and single Fluncle holds, with the artists and labels behind them.";

function pagedMeta(page: number): { description: string; title: string } {
  if (page <= 1) {
    return { description, title };
  }

  return {
    description: `Page ${page} of every drum & bass album, EP and single Fluncle holds, with the artists and labels behind them.`,
    title: `Every drum & bass album, page ${page} · Fluncle`,
  };
}

function albumsHead(loaderData: AlbumsPageData | undefined) {
  if (loaderData?.status !== "found") {
    return {};
  }

  const filtered = loaderData.q !== undefined || loaderData.requestedOrder !== "most";
  const canonical =
    filtered || loaderData.page <= 1
      ? `${siteUrl}/albums`
      : `${siteUrl}/albums?page=${loaderData.page}`;

  const meta = pagedMeta(filtered ? 1 : loaderData.page);
  const ogImage = `${siteUrl}/api/og/hub?hub=albums`;
  const metaTags = [
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

  if (filtered) {
    metaTags.push({ content: "noindex, follow", name: "robots" });

    return { links: [{ href: canonical, rel: "canonical" }], meta: metaTags };
  }

  const albums = loaderData.hub.items;
  const collectionPage = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    mainEntity: {
      "@type": "ItemList",
      itemListElement: albums.map((album, index) => ({
        "@type": "ListItem",
        name: album.name,
        position: index + 1,
        url: `${siteUrl}/album/${encodeURIComponent(album.slug)}`,
      })),
      numberOfItems: loaderData.hub.total,
    },
    name: "Every drum & bass album Fluncle holds",
    url: `${siteUrl}/albums`,
  };

  return {
    links: [{ href: canonical, rel: "canonical" }],
    meta: metaTags,
    scripts: [jsonLdScript(collectionPage)],
  };
}

// oxlint-disable-next-line sort-keys -- TanStack canonical property order (validateSearch → head); see AGENTS.md
export const Route = createFileRoute("/albums/")({
  validateSearch: (search: Record<string, unknown>): AlbumsSearch => ({
    order: hubOrderParam(search["order"]),
    page: pageParam(search["page"]),
    q: textParam(search["q"]),
  }),
  loaderDeps: ({ search }) => ({ order: search.order, page: search.page, q: search.q }),
  loader: async ({ deps }): Promise<AlbumsPageData> => {
    const data = await fetchAlbumsPage({
      data: { order: deps.order, page: deps.page, q: deps.q },
    });

    if (data.status === "missing") {
      throw notFound();
    }

    return data;
  },
  head: ({ loaderData }: { loaderData?: AlbumsPageData }) => albumsHead(loaderData),
  component: AlbumsPage,
  notFoundComponent: StoryNotFoundState,
});

type AlbumsSearch = { order?: "az" | "recent"; page?: number; q?: string };

function mastheadLine(total: number): string {
  return total > 1
    ? `${countFormatter.format(total)} drum & bass records.`
    : "Drum & bass records.";
}

function albumMeta(album: AlbumHubEntry): string {
  return album.year
    ? `${album.year} · ${tracksCount(album.trackCount)}`
    : tracksCount(album.trackCount);
}

function AlbumTile({
  album,
  eager,
  priority,
}: {
  album: AlbumHubEntry;
  eager?: boolean;
  priority?: boolean;
}) {
  return (
    <HubTile kind="album" lit={album.certified} name={album.name} slug={album.slug}>
      <Link
        className={album.certified ? "hub-tile-certified" : undefined}
        params={{ slug: album.slug }}
        to="/album/$slug"
      >
        <TrackArtwork
          alt=""
          className="artist-grid-cover"
          eager={eager}
          priority={priority}
          sizes="(min-width: 40rem) 120px, 50vw"
          src={albumCoverAtSize(album.coverImageUrl, "hub")}
          srcSet={hubCoverSrcSet(album.coverImageUrl)}
        />
        <span className="artist-grid-line">{album.name}</span>
        {album.artists.length > 0 ? (
          <span className="artist-grid-credit">{album.artists.join(", ")}</span>
        ) : null}
        <span className="artist-grid-count">{albumMeta(album)}</span>
      </Link>
    </HubTile>
  );
}

function matchCount(count: number): string {
  return `${countFormatter.format(count)} ${count === 1 ? "match" : "matches"}`;
}

function AlbumsPage() {
  const data = Route.useLoaderData();
  const navigate = useNavigate();

  if (data.status !== "found") {
    return null;
  }

  const { hub, order, q, thisMonth } = data;
  const filtered = q !== undefined;
  const buildHref = (page: number) => hubHref("/albums", { order, page, q });
  const showSearch = filtered || hub.total > 0;
  const setOrder = (next: HubOrder) =>
    void navigate({ search: { order: hubOrderParam(next), q }, to: "/albums" });

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <h1 className="log-coordinate log-index-title">Albums</h1>
          <p className="log-index-intro">{mastheadLine(filtered ? 0 : hub.total)}</p>
        </header>

        {showSearch ? (
          <HubSearchInput
            label="Search albums by name"
            onSearch={(term) =>
              void navigate({ search: { order: hubOrderParam(order), q: term }, to: "/albums" })
            }
            placeholder="Search albums"
            value={q}
          />
        ) : undefined}

        {filtered ? (
          <p aria-live="polite" className="tracks-hub-matchline">
            {matchCount(hub.total)}
          </p>
        ) : undefined}

        <HubThisMonth count={thisMonth.length} label="Records out this month">
          {thisMonth.map((album) => (
            <AlbumTile album={album} key={album.slug} />
          ))}
        </HubThisMonth>

        {hub.items.length === 0 ? (
          <p className="log-index-empty empty-scanlines">
            {filtered ? "No albums match that name." : "No drum & bass records yet."}
          </p>
        ) : (
          <>
            <h2 className="sr-only">Every record</h2>
            <HubOrderSwitch onChange={setOrder} order={order} recentReady={data.recentReady} />
            {filtered || order !== "az" ? undefined : (
              <HubLetterLane
                buildHref={buildHref}
                label="Albums A to Z"
                letters={hub.letters ?? []}
              />
            )}
            <ul aria-label="Albums" className="artist-grid hub-grid">
              {hub.items.map((album, index) => (
                <AlbumTile
                  album={album}
                  eager={index < 4}
                  key={album.slug}
                  priority={index === 0}
                />
              ))}
            </ul>
            <CataloguePager
              buildHref={buildHref}
              label="Albums, more pages"
              page={hub.page}
              pageCount={hub.pageCount}
            />
          </>
        )}

        <HubFooter current="/albums" />
      </article>
    </main>
  );
}
