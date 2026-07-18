import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { CataloguePager } from "@/components/catalogue-groups";
import { CatalogueHubPageSection, CatalogueHubSection } from "@/components/catalogue-hub-section";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { TrackArtwork } from "@/components/track-artwork";
import { siteUrl } from "@/lib/fluncle-links";
import { findingsCount, tracksCount } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { albumCoverAtSize } from "@/lib/media";
import {
  type AlbumCatalogueEntry,
  type AlbumIndexEntry,
  countAlbumsCatalogue,
  listAlbumsCatalogue,
  listAlbumsCataloguePage,
  listAlbumsWithFindingCounts,
} from "@/lib/server/albums";
import {
  CATALOGUE_HUB_DEFAULT_LIMIT,
  type CatalogueHubNumberedPage,
  CatalogueHubPageOutOfRangeError,
  type CatalogueHubPage,
} from "@/lib/server/labels";

// The albums index: every record Fluncle has logged a finding off, cover-led (the album art
// IS the entity here), each linking to its `/album/<slug>` page — the internal-link hub that
// keeps the album pages from being orphans (the `/artists` index precedent).
//
// The TOP section is bounded by the ARCHIVE, not the catalogue: an album earns a row here because
// Fluncle found something on it. Below it, "More records" carries the INDEXABLE findings-free records
// the crawler minted a page for. The param-free `/albums` streams them in on scroll (the human read);
// a crawlable `?page=N` variant SSRs each page's tiles behind a real-anchor pager. Albums have NO A–Z
// lane — an album's identity is its cover, not a title-initial, so browse-by-letter is not how records
// are dug — so the numbered pager IS the album hub's crawl entry into the long tail.

type AlbumsCatalogue =
  | { mode: "page"; page: CatalogueHubNumberedPage<AlbumCatalogueEntry> }
  | { mode: "scroll"; pageCount: number; seed: CatalogueHubPage<AlbumCatalogueEntry> };

type AlbumsPageData =
  | {
      catalogue: AlbumsCatalogue;
      findings: AlbumIndexEntry[];
      page: number;
      status: "found";
    }
  | { status: "missing" };

async function resolveAlbumsPage(page: number | undefined): Promise<AlbumsPageData> {
  if (page !== undefined && page > 1) {
    const [paged, findings] = await Promise.all([
      listAlbumsCataloguePage(page).catch((error: unknown) => {
        if (error instanceof CatalogueHubPageOutOfRangeError) {
          return null;
        }

        throw error;
      }),
      listAlbumsWithFindingCounts(),
    ]);

    if (paged === null) {
      return { status: "missing" };
    }

    return { catalogue: { mode: "page", page: paged }, findings, page, status: "found" };
  }

  const [findings, seed, total] = await Promise.all([
    listAlbumsWithFindingCounts(),
    listAlbumsCatalogue({ limit: CATALOGUE_HUB_DEFAULT_LIMIT }),
    countAlbumsCatalogue(),
  ]);

  return {
    catalogue: {
      mode: "scroll",
      pageCount: Math.max(Math.ceil(total / CATALOGUE_HUB_DEFAULT_LIMIT), 1),
      seed,
    },
    findings,
    page: 1,
    status: "found",
  };
}

const fetchAlbumsPage = createServerFn({ method: "GET" })
  .validator((data: { page?: number }) => data)
  .handler(({ data }): Promise<AlbumsPageData> => resolveAlbumsPage(data.page));

// Subsequent "more records" scroll pages go through the SAME serverFn the loader seeded from —
// a slug keyset, no oRPC op (the homepage-feed precedent).
const fetchAlbumsCatalogue = createServerFn({ method: "GET" })
  .validator((data: { cursor?: string; limit?: number }) => data)
  .handler(({ data }) => listAlbumsCatalogue({ cursor: data.cursor, limit: data.limit }));

// Machine-facing strings stay honestly-plain third-person (the Narrator rule), and they carry the
// genre keyword — Bing flagged the hub layer for short, keyword-free titles and identical paged
// meta (2026-07-18). Paged variants bake their page number into BOTH strings.
const title = "Drum & bass albums, EPs and singles · Fluncle";
const description =
  "Every drum & bass album, EP and single Fluncle has pulled a banger from, mapped across the Galaxy with the artists and labels behind them.";

function pagedMeta(page: number): { description: string; title: string } {
  if (page <= 1) {
    return { description, title };
  }

  return {
    description: `Page ${page} of every drum & bass album, EP and single Fluncle has pulled a banger from, with the artists and labels behind them.`,
    title: `Drum & bass albums, page ${page} · Fluncle`,
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

  // The ItemList stays Fluncle's CURATED list (the findings section only): the catalogue records'
  // pages are already carried by the sitemap. It rides as the `mainEntity` of a `CollectionPage`,
  // carrying `numberOfItems` so the list's size is machine-readable without counting.
  const albums = loaderData.findings;
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
      numberOfItems: albums.length,
    },
    name: "Fluncle's albums",
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

function AlbumsPage() {
  const data = Route.useLoaderData();

  if (data.status !== "found") {
    return null;
  }

  const { catalogue, findings } = data;
  const buildHref = (page: number) => (page <= 1 ? "/albums" : `/albums?page=${page}`);
  const renderTile = (album: AlbumCatalogueEntry) => (
    <li key={album.slug}>
      <Link params={{ slug: album.slug }} to="/album/$slug">
        <TrackArtwork
          alt=""
          className="artist-grid-cover"
          src={albumCoverAtSize(album.coverImageUrl, "large")}
        />
        <span className="artist-grid-line">{album.name}</span>
        <span className="artist-grid-count">{tracksCount(album.trackCount)}</span>
      </Link>
    </li>
  );

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <h1 className="log-coordinate log-index-title">Albums</h1>
          <p className="log-index-intro">
            Every drum &amp; bass record with a finding in the archive. {findings.length} logged.
          </p>
        </header>

        {findings.length === 0 ? (
          <p className="log-index-empty empty-scanlines">No albums logged yet. Quiet sector.</p>
        ) : (
          <ul aria-label="Albums" className="artist-grid">
            {findings.map((album) => (
              <li key={album.slug}>
                <Link params={{ slug: album.slug }} to="/album/$slug">
                  <TrackArtwork
                    alt=""
                    className="artist-grid-cover"
                    src={albumCoverAtSize(album.coverImageUrl, "large")}
                  />
                  <span className="artist-grid-line">{album.name}</span>
                  <span className="artist-grid-count">{findingsCount(album.findingCount)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {catalogue.mode === "scroll" ? (
          <CatalogueHubSection
            gridClassName="artist-grid"
            heading="More records"
            headingId="albums-catalogue-heading"
            initialPage={catalogue.seed}
            lane={
              <CataloguePager
                buildHref={buildHref}
                label="More records, more pages"
                page={1}
                pageCount={catalogue.pageCount}
              />
            }
            listLabel="More records"
            queryFn={(cursor) =>
              fetchAlbumsCatalogue({ data: { cursor, limit: CATALOGUE_HUB_DEFAULT_LIMIT } })
            }
            queryKey="albums-catalogue"
            renderTile={renderTile}
          />
        ) : (
          <CatalogueHubPageSection
            gridClassName="artist-grid"
            heading="More records"
            headingId="albums-catalogue-heading"
            items={catalogue.page.items}
            listLabel="More records"
            pager={
              <CataloguePager
                buildHref={buildHref}
                label="More records, more pages"
                page={catalogue.page.page}
                pageCount={catalogue.page.pageCount}
              />
            }
            renderTile={renderTile}
          />
        )}

        <footer className="log-plate-footer">
          <Link to="/">Back to the archive</Link>
          <Link to="/log">The full log</Link>
        </footer>
      </article>
    </main>
  );
}
