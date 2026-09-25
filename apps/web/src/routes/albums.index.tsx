import { Link, createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { CataloguePager } from "@/components/catalogue-groups";
import { HubSearchInput } from "@/components/hub-search-input";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { TrackArtwork } from "@/components/track-artwork";
import { siteUrl } from "@/lib/fluncle-links";
import { tracksCount } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { albumCoverAtSize, HUB_COVER_TILE_SIZE } from "@/lib/media";
import { pageParam, textParam } from "@/lib/search-params";
import { type AlbumHubEntry, listAlbumsHubPage } from "@/lib/server/albums";
import { type CatalogueHubNumberedPage } from "@/lib/server/labels";

const countFormatter = new Intl.NumberFormat("en-US");

type AlbumsPageData =
  | {
      hub: CatalogueHubNumberedPage<AlbumHubEntry>;
      page: number;

      q: string | undefined;
      status: "found";
    }
  | { status: "missing" };

async function resolveAlbumsPage(
  page: number | undefined,
  q: string | undefined,
): Promise<AlbumsPageData> {
  const requested = page ?? 1;
  const hub = await listAlbumsHubPage(requested, q);

  if (requested > hub.pageCount) {
    return { status: "missing" };
  }

  return { hub, page: requested, q, status: "found" };
}

const fetchAlbumsPage = createServerFn({ method: "GET" })
  .validator((data: { page?: number; q?: string }) => data)
  .handler(({ data }): Promise<AlbumsPageData> => resolveAlbumsPage(data.page, data.q));

const title = "Every drum & bass album, A to Z · Fluncle";
const description =
  "Every drum & bass album, EP and single Fluncle holds, A to Z, with the artists and labels behind them.";

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

  const filtered = loaderData.q !== undefined;
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
    page: pageParam(search["page"]),
    q: textParam(search["q"]),
  }),
  loaderDeps: ({ search }) => ({ page: search.page, q: search.q }),
  loader: async ({ deps }): Promise<AlbumsPageData> => {
    const data = await fetchAlbumsPage({ data: { page: deps.page, q: deps.q } });

    if (data.status === "missing") {
      throw notFound();
    }

    return data;
  },
  head: ({ loaderData }: { loaderData?: AlbumsPageData }) => albumsHead(loaderData),
  component: AlbumsPage,
  notFoundComponent: StoryNotFoundState,
});

type AlbumsSearch = { page?: number; q?: string };

function mastheadLine(total: number): string {
  return total > 1
    ? `${countFormatter.format(total)} drum & bass records, A to Z.`
    : "Drum & bass records, A to Z.";
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

  const { hub, q } = data;
  const filtered = q !== undefined;
  const buildHref = (page: number) => buildAlbumsHref(q, page);
  const showSearch = filtered || hub.total > 0;

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
            onSearch={(term) => void navigate({ search: { q: term }, to: "/albums" })}
            placeholder="Search albums"
            value={q}
          />
        ) : undefined}

        {filtered ? (
          <p aria-live="polite" className="tracks-hub-matchline">
            {matchCount(hub.total)}
          </p>
        ) : undefined}

        {hub.items.length === 0 ? (
          <p className="log-index-empty empty-scanlines">
            {filtered ? "No albums match that name." : "No drum & bass records yet."}
          </p>
        ) : (
          <>
            <ul aria-label="Albums" className="artist-grid hub-grid">
              {hub.items.map((album) => (
                <li key={album.slug}>
                  <Link
                    className={album.certified ? "hub-tile-certified" : undefined}
                    params={{ slug: album.slug }}
                    to="/album/$slug"
                  >
                    <TrackArtwork
                      alt=""
                      className="artist-grid-cover"
                      src={albumCoverAtSize(album.coverImageUrl, HUB_COVER_TILE_SIZE)}
                    />
                    <span className="artist-grid-line">{album.name}</span>
                    <span className="artist-grid-count">{tracksCount(album.trackCount)}</span>
                  </Link>
                </li>
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

        <footer className="log-plate-footer">
          <Link to="/">Home</Link>
          <Link to="/log">The full log</Link>
        </footer>
      </article>
    </main>
  );
}

function buildAlbumsHref(q: string | undefined, page: number): string {
  const params = new URLSearchParams();

  if (q !== undefined) {
    params.set("q", q);
  }
  if (page > 1) {
    params.set("page", String(page));
  }

  const query = params.toString();

  return query ? `/albums?${query}` : "/albums";
}
