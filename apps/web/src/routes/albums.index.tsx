import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { TrackArtwork } from "@/components/track-artwork";
import { siteUrl } from "@/lib/fluncle-links";
import { findingsCount } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { albumCoverAtSize } from "@/lib/media";
import { type AlbumIndexEntry, listAlbumsWithFindingCounts } from "@/lib/server/albums";

// The albums index: every record Fluncle has logged a finding off, cover-led (the album art
// IS the entity here), each linking to its `/album/<slug>` page — the internal-link hub that
// keeps the album pages from being orphans (the `/artists` index precedent).
//
// Bounded by the ARCHIVE, not the catalogue: an album earns a row here because Fluncle found
// something on it, so this index cannot balloon to catalogue size (lib/server/albums.ts).

const fetchAlbums = createServerFn({ method: "GET" }).handler(() => listAlbumsWithFindingCounts());

const title = "Fluncle: the albums";
const description = "Every record Fluncle has found a banger on, mapped across the Galaxy.";

function albumsHead(loaderData: AlbumIndexEntry[] | undefined) {
  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: loaderData?.map((album, index) => ({
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
  loader: () => fetchAlbums(),
  head: ({ loaderData }: { loaderData?: AlbumIndexEntry[] }) => albumsHead(loaderData),
});

function AlbumsPage() {
  const albums = Route.useLoaderData();

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <p className="log-nameplate">Fluncle's Findings</p>
          <h1 className="log-coordinate log-index-title">Albums</h1>
          <p className="log-index-intro">
            Every record I've found a banger on. {albums.length} logged so far.
          </p>
        </header>

        {albums.length === 0 ? (
          <p className="log-index-empty empty-scanlines">No albums logged yet. Quiet sector.</p>
        ) : (
          <ul aria-label="Albums" className="artist-grid">
            {albums.map((album) => (
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

        <footer className="log-plate-footer">
          <Link to="/">Back to the archive</Link>
          <Link to="/log">The full log</Link>
        </footer>
      </article>
    </main>
  );
}
