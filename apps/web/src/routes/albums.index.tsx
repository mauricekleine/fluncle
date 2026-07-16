import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { CatalogueHubSection } from "@/components/catalogue-hub-section";
import { TrackArtwork } from "@/components/track-artwork";
import { siteUrl } from "@/lib/fluncle-links";
import { findingsCount, tracksCount } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { albumCoverAtSize } from "@/lib/media";
import {
  type AlbumCatalogueEntry,
  type AlbumIndexEntry,
  listAlbumsCatalogue,
  listAlbumsWithFindingCounts,
} from "@/lib/server/albums";
import { CATALOGUE_HUB_DEFAULT_LIMIT, type CatalogueHubPage } from "@/lib/server/labels";

// The albums index: every record Fluncle has logged a finding off, cover-led (the album art
// IS the entity here), each linking to its `/album/<slug>` page — the internal-link hub that
// keeps the album pages from being orphans (the `/artists` index precedent).
//
// The TOP section is bounded by the ARCHIVE, not the catalogue: an album earns a row here because
// Fluncle found something on it. Below it, "Also in the catalogue" carries the INDEXABLE
// findings-free records the crawler minted a page for (`listAlbumsCatalogue`), rendered UNLIT.

type AlbumsPageData = {
  catalogue: CatalogueHubPage<AlbumCatalogueEntry>;
  findings: AlbumIndexEntry[];
};

const fetchAlbumsPage = createServerFn({ method: "GET" }).handler(
  async (): Promise<AlbumsPageData> => {
    const [findings, catalogue] = await Promise.all([
      listAlbumsWithFindingCounts(),
      listAlbumsCatalogue({ limit: CATALOGUE_HUB_DEFAULT_LIMIT }),
    ]);

    return { catalogue, findings };
  },
);

// Subsequent "also in the catalogue" pages go through the SAME serverFn the loader seeded from —
// a slug keyset, no oRPC op (the homepage-feed precedent).
const fetchAlbumsCatalogue = createServerFn({ method: "GET" })
  .validator((data: { cursor?: string; limit?: number }) => data)
  .handler(({ data }) => listAlbumsCatalogue({ cursor: data.cursor, limit: data.limit }));

const title = "Fluncle: the albums";
const description = "Every record Fluncle has found a banger on, mapped across the Galaxy.";

function albumsHead(loaderData: AlbumsPageData | undefined) {
  // The ItemList stays Fluncle's CURATED list (the findings section only): the catalogue records'
  // pages are already carried by the sitemap.
  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: loaderData?.findings.map((album, index) => ({
      "@type": "ListItem",
      name: album.name,
      position: index + 1,
      url: `${siteUrl}/album/${encodeURIComponent(album.slug)}`,
    })),
    name: "Fluncle's albums",
    url: `${siteUrl}/albums`,
  };

  return {
    links: [{ href: `${siteUrl}/albums`, rel: "canonical" }],
    meta: [
      { title },
      { content: description, name: "description" },
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: `${siteUrl}/fluncle-cover.png`, property: "og:image" },
      { content: `${siteUrl}/albums`, property: "og:url" },
    ],
    scripts: [jsonLdScript(itemList)],
  };
}

// oxlint-disable-next-line sort-keys -- TanStack canonical property order (loader before head); see AGENTS.md
export const Route = createFileRoute("/albums/")({
  component: AlbumsPage,
  loader: () => fetchAlbumsPage(),
  head: ({ loaderData }: { loaderData?: AlbumsPageData }) => albumsHead(loaderData),
});

function AlbumsPage() {
  const { catalogue, findings } = Route.useLoaderData();

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <p className="log-nameplate">Fluncle's Findings</p>
          <h1 className="log-coordinate log-index-title">Albums</h1>
          <p className="log-index-intro">
            Every record I've found a banger on. {findings.length} logged so far.
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

        <CatalogueHubSection
          gridClassName="artist-grid"
          heading="More records"
          headingId="albums-catalogue-heading"
          initialPage={catalogue}
          intro="Records the probes mapped. I haven't logged anything off these yet."
          listLabel="More records"
          queryFn={(cursor) =>
            fetchAlbumsCatalogue({ data: { cursor, limit: CATALOGUE_HUB_DEFAULT_LIMIT } })
          }
          queryKey="albums-catalogue"
          renderTile={(album) => (
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
          )}
        />

        <footer className="log-plate-footer">
          <Link to="/">Back to the archive</Link>
          <Link to="/log">The full log</Link>
        </footer>
      </article>
    </main>
  );
}
