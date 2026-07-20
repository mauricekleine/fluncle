import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { CataloguePager } from "@/components/catalogue-groups";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { TrackArtwork } from "@/components/track-artwork";
import { siteUrl } from "@/lib/fluncle-links";
import { tracksCount } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { albumCoverAtSize, COVER_TILE_SIZE } from "@/lib/media";
import { type AlbumHubEntry, listAlbumsHubPage } from "@/lib/server/albums";
import { type CatalogueHubNumberedPage } from "@/lib/server/labels";

// The albums index: ONE alphabetical index of every record Fluncle holds — the certified findings
// and the wider catalogue he is charting — cover-led (the album art IS the entity here), each tile
// linking to its `/album/<slug>` page (the internal-link hub that keeps the album pages from being
// orphans). A certified record's name takes the certification light (DESIGN.md's Unlit Rule, Eclipse
// Gold); an uncertified one keeps the plain ink. The distinction is visual only — no badge, no tier
// heading, no finding count.
//
// Albums have NO A–Z lane — an album's identity is its cover, not a title-initial, so browse-by-
// letter is not how records are dug — so the numbered `?page=N` pager IS the album index's crawl
// entry into the long tail. Every page — page 1 included — SSRs one static slice of tiles behind a
// real-anchor pager. A page past the end 404s — never a clamp to page 1.

const countFormatter = new Intl.NumberFormat("en-US");

type AlbumsPageData =
  | {
      hub: CatalogueHubNumberedPage<AlbumHubEntry>;
      page: number;
      status: "found";
    }
  | { status: "missing" };

async function resolveAlbumsPage(page: number | undefined): Promise<AlbumsPageData> {
  const requested = page ?? 1;
  const hub = await listAlbumsHubPage(requested);

  if (requested > hub.pageCount) {
    return { status: "missing" };
  }

  return { hub, page: requested, status: "found" };
}

const fetchAlbumsPage = createServerFn({ method: "GET" })
  .validator((data: { page?: number }) => data)
  .handler(({ data }): Promise<AlbumsPageData> => resolveAlbumsPage(data.page));

// Machine-facing strings stay honestly-plain third-person (the Narrator rule), and they carry the
// genre keyword — Bing flagged the hub layer for short, keyword-free titles and identical paged
// meta (2026-07-18). Paged variants bake their page number into BOTH strings.
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

  // Self-referencing PER PAGE: `?page=N` is its own canonical, page 1 stays the bare `/albums`. The
  // paged variants are real content — `noindex` NEVER.
  const canonical =
    loaderData.page > 1 ? `${siteUrl}/albums?page=${loaderData.page}` : `${siteUrl}/albums`;

  // The ItemList carries the page's tiles — every one a real `/album/<slug>` page — as the
  // `mainEntity` of a `CollectionPage`, carrying `numberOfItems` so the list's size is machine-
  // readable without counting.
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

  const meta = pagedMeta(loaderData.page);

  return {
    links: [{ href: canonical, rel: "canonical" }],
    meta: [
      { title: meta.title },
      { content: meta.description, name: "description" },
      { content: meta.title, property: "og:title" },
      { content: meta.description, property: "og:description" },
      { content: `${siteUrl}/fluncle-cover.png`, property: "og:image" },
      { content: canonical, property: "og:url" },
      { content: "summary_large_image", name: "twitter:card" },
      { content: meta.title, name: "twitter:title" },
      { content: meta.description, name: "twitter:description" },
    ],
    scripts: [jsonLdScript(collectionPage)],
  };
}

// oxlint-disable-next-line sort-keys -- TanStack canonical property order (validateSearch → head); see AGENTS.md
export const Route = createFileRoute("/albums/")({
  validateSearch: (search: Record<string, unknown>): AlbumsSearch => ({
    page: pageParam(search["page"]),
  }),
  loaderDeps: ({ search }) => ({ page: search.page }),
  loader: async ({ deps }): Promise<AlbumsPageData> => {
    const data = await fetchAlbumsPage({ data: { page: deps.page } });

    if (data.status === "missing") {
      throw notFound();
    }

    return data;
  },
  head: ({ loaderData }: { loaderData?: AlbumsPageData }) => albumsHead(loaderData),
  component: AlbumsPage,
  notFoundComponent: StoryNotFoundState,
});

type AlbumsSearch = { page?: number };

/** A page param the reader typed: junk or an absent value folds to undefined (the param-free view). */
function pageParam(value: unknown): number | undefined {
  const n = Number(value);

  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : undefined;
}

// One composed string (not JSX fragments) so the count is a single SSR text node. The count clause
// drops at ≤ 1 ("all 1 of them" is not a sentence).
function mastheadLine(total: number): string {
  return total > 1
    ? `Every drum & bass record Fluncle holds, all ${countFormatter.format(total)} of them.`
    : "Every drum & bass record Fluncle holds.";
}

function AlbumsPage() {
  const data = Route.useLoaderData();

  if (data.status !== "found") {
    return null;
  }

  const { hub } = data;
  const buildHref = (page: number) => (page <= 1 ? "/albums" : `/albums?page=${page}`);

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <h1 className="log-coordinate log-index-title">Albums</h1>
          <p className="log-index-intro">{mastheadLine(hub.total)}</p>
        </header>

        {hub.total === 0 ? (
          <p className="log-index-empty empty-scanlines">No drum &amp; bass records yet.</p>
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
                      src={albumCoverAtSize(album.coverImageUrl, COVER_TILE_SIZE)}
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
