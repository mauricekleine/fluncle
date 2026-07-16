import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { ArtistAvatar } from "@/components/artist-avatar";
import { CatalogueHubSection } from "@/components/catalogue-hub-section";
import { siteUrl } from "@/lib/fluncle-links";
import { findingsCount, tracksCount } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import {
  type ArtistCatalogueEntry,
  type ArtistIndexEntry,
  listArtistsCatalogue,
  listArtistsWithFindingCounts,
} from "@/lib/server/artists";
import { CATALOGUE_HUB_DEFAULT_LIMIT, type CatalogueHubPage } from "@/lib/server/labels";

// The artists index: every artist Fluncle has logged a finding from, cover-led, each linking to
// its `/artist/<slug>` page — the internal-link hub that keeps the artist pages from being orphans
// (Unit 3, artist-relationship RFC §3).
//
// Below the editorial list, "Also in the catalogue" carries the INDEXABLE findings-free artists
// the crawler minted a page for (`listArtistsCatalogue`), rendered UNLIT and never claimed.

type ArtistsPageData = {
  catalogue: CatalogueHubPage<ArtistCatalogueEntry>;
  findings: ArtistIndexEntry[];
};

const fetchArtistsPage = createServerFn({ method: "GET" }).handler(
  async (): Promise<ArtistsPageData> => {
    const [findings, catalogue] = await Promise.all([
      listArtistsWithFindingCounts(),
      listArtistsCatalogue({ limit: CATALOGUE_HUB_DEFAULT_LIMIT }),
    ]);

    return { catalogue, findings };
  },
);

// Subsequent "also in the catalogue" pages go through the SAME serverFn the loader seeded from —
// a slug keyset, no oRPC op (the homepage-feed precedent).
const fetchArtistsCatalogue = createServerFn({ method: "GET" })
  .validator((data: { cursor?: string; limit?: number }) => data)
  .handler(({ data }) => listArtistsCatalogue({ cursor: data.cursor, limit: data.limit }));

const title = "Fluncle: the artists";
const description =
  "Every artist Fluncle has found and logged in the Galaxy, mapped by the bangers they made.";

function artistsHead(loaderData: ArtistsPageData | undefined) {
  // The ItemList stays Fluncle's CURATED list (the findings section only): the catalogue artists'
  // pages are already carried by the sitemap.
  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: loaderData?.findings.map((artist, index) => ({
      "@type": "ListItem",
      name: artist.name,
      position: index + 1,
      url: `${siteUrl}/artist/${encodeURIComponent(artist.slug)}`,
    })),
    name: "Fluncle's artists",
    url: `${siteUrl}/artists`,
  };

  return {
    links: [{ href: `${siteUrl}/artists`, rel: "canonical" }],
    meta: [
      { title },
      { content: description, name: "description" },
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: `${siteUrl}/fluncle-cover.png`, property: "og:image" },
      { content: `${siteUrl}/artists`, property: "og:url" },
    ],
    // JSON-LD goes through `jsonLdScript`, which HTML-escapes the serialized
    // payload before it reaches the inline <script>'s `children` (rendered raw via
    // dangerouslySetInnerHTML), so a `</script>` in a (Spotify-sourced) artist name
    // can't break out of the <script> (stored-XSS sink, security review).
    scripts: [jsonLdScript(itemList)],
  };
}

// oxlint-disable-next-line sort-keys -- TanStack canonical property order (loader before head); see AGENTS.md
export const Route = createFileRoute("/artists/")({
  component: ArtistsPage,
  loader: () => fetchArtistsPage(),
  head: ({ loaderData }: { loaderData?: ArtistsPageData }) => artistsHead(loaderData),
});

function ArtistsPage() {
  const { catalogue, findings } = Route.useLoaderData();

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <p className="log-nameplate">Fluncle's Findings</p>
          <h1 className="log-coordinate log-index-title">Artists</h1>
          <p className="log-index-intro">
            Everyone I've found a banger from out here. {findings.length} logged so far.
          </p>
        </header>

        {findings.length === 0 ? (
          <p className="log-index-empty empty-scanlines">No artists logged yet. Quiet sector.</p>
        ) : (
          <ul className="artist-avatar-grid" aria-label="Artists">
            {findings.map((artist) => (
              <li key={artist.slug}>
                <Link params={{ slug: artist.slug }} to="/artist/$slug">
                  <ArtistAvatar
                    className="artist-card-avatar"
                    name={artist.name}
                    src={artist.imageUrl}
                  />
                  <span className="artist-grid-line">{artist.name}</span>
                  <span className="artist-grid-count">{findingsCount(artist.findingCount)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <CatalogueHubSection
          gridClassName="artist-avatar-grid"
          heading="More artists"
          headingId="artists-catalogue-heading"
          initialPage={catalogue}
          intro="Artists the probes mapped. I haven't logged anything off these yet."
          listLabel="More artists"
          queryFn={(cursor) =>
            fetchArtistsCatalogue({ data: { cursor, limit: CATALOGUE_HUB_DEFAULT_LIMIT } })
          }
          queryKey="artists-catalogue"
          renderTile={(artist) => (
            <li key={artist.slug}>
              <Link params={{ slug: artist.slug }} to="/artist/$slug">
                <ArtistAvatar
                  className="artist-card-avatar"
                  name={artist.name}
                  src={artist.imageUrl}
                />
                <span className="artist-grid-line">{artist.name}</span>
                <span className="artist-grid-count">{tracksCount(artist.trackCount)}</span>
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
