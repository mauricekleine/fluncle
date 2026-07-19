import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { ArtistAvatar } from "@/components/artist-avatar";
import { CataloguePager } from "@/components/catalogue-groups";
import { CatalogueHubPageSection, HubLetterLane } from "@/components/catalogue-hub-section";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { siteUrl } from "@/lib/fluncle-links";
import { findingsCount, tracksCount } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import {
  type ArtistCatalogueEntry,
  type ArtistIndexEntry,
  listArtistsCataloguePage,
  listArtistsCatalogueLetters,
  listArtistsWithFindingCounts,
} from "@/lib/server/artists";
import {
  type CatalogueHubLetter,
  type CatalogueHubNumberedPage,
  CatalogueHubPageOutOfRangeError,
} from "@/lib/server/labels";

// The artists index: every artist Fluncle has logged a finding from, cover-led, each linking to
// its `/artist/<slug>` page — the internal-link hub that keeps the artist pages from being orphans
// (Unit 3, artist-relationship RFC §3).
//
// Below the editorial list, "More artists" carries the INDEXABLE findings-free artists the crawler
// minted a page for. Every page — page 1 included — SSRs one static slice of tiles behind a
// real-anchor `?page=N` pager, with an A–Z fast lane linking every region of the alphabet — so the
// long tail is reachable by internal links (and the footer by everyone), not the sitemap alone.

type ArtistsPageData =
  | {
      catalogue: CatalogueHubNumberedPage<ArtistCatalogueEntry>;
      findings: ArtistIndexEntry[];
      // Each present first letter → the page its first findings-free artist lands on (the A–Z lane).
      letters: CatalogueHubLetter[];
      // The current page (1 for the bare `/artists`) — the head's per-page canonical keys off it.
      page: number;
      status: "found";
    }
  | { status: "missing" };

// Resolve the hub's data: the findings grid + one static OFFSET slice of the findings-free section.
// A bare `/artists` (or `?page=1`) is page 1; a `?page=N` is the Nth slice. A page past the end
// throws `CatalogueHubPageOutOfRangeError`, which maps to a 404 (never a clamp to page 1 — that
// would be a second URL for page 1's tiles).
async function resolveArtistsPage(page: number | undefined): Promise<ArtistsPageData> {
  const requested = page ?? 1;
  const [paged, findings, letters] = await Promise.all([
    listArtistsCataloguePage(requested).catch((error: unknown) => {
      if (error instanceof CatalogueHubPageOutOfRangeError) {
        return null;
      }

      throw error;
    }),
    listArtistsWithFindingCounts(),
    listArtistsCatalogueLetters(),
  ]);

  if (paged === null) {
    return { status: "missing" };
  }

  return { catalogue: paged, findings, letters, page: requested, status: "found" };
}

const fetchArtistsPage = createServerFn({ method: "GET" })
  .validator((data: { page?: number }) => data)
  .handler(({ data }): Promise<ArtistsPageData> => resolveArtistsPage(data.page));

// Machine-facing strings stay honestly-plain third-person (the Narrator rule), and they carry the
// genre keyword: "Fluncle: the artists" told a search engine nothing, and Bing flagged the whole
// hub layer for short titles + identical paged meta (2026-07-18). Paged variants get their page
// number baked into BOTH strings so no two `?page=N` URLs share identical meta.
const title = "Drum & bass artists, A to Z · Fluncle";
const description =
  "Every drum & bass artist Fluncle has found and logged in the Galaxy, A to Z, each mapped by the bangers they made and the labels that pressed them.";

function pagedMeta(page: number): { description: string; title: string } {
  if (page <= 1) {
    return { description, title };
  }

  return {
    description: `Page ${page} of every drum & bass artist Fluncle has found and logged in the Galaxy, A to Z, each mapped by the bangers they made.`,
    title: `Drum & bass artists, page ${page} · Fluncle`,
  };
}

function artistsHead(loaderData: ArtistsPageData | undefined) {
  if (loaderData?.status !== "found") {
    return {};
  }

  // Self-referencing PER PAGE: `?page=N` is its own canonical, page 1 stays the bare `/artists`
  // (the artist/label entity-page precedent). The paged variants are real content — `noindex` NEVER.
  const canonical =
    loaderData.page > 1 ? `${siteUrl}/artists?page=${loaderData.page}` : `${siteUrl}/artists`;

  // The ItemList stays Fluncle's CURATED list (the findings section only): the catalogue artists'
  // pages are already carried by the sitemap. It rides as the `mainEntity` of a `CollectionPage` —
  // the honest shape for "this page is a hub OF a list" — carrying `numberOfItems` so a crawler
  // knows the list's size without counting.
  const artists = loaderData.findings;
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
      numberOfItems: artists.length,
    },
    name: "Fluncle's artists",
    url: `${siteUrl}/artists`,
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
    // JSON-LD goes through `jsonLdScript`, which HTML-escapes the serialized
    // payload before it reaches the inline <script>'s `children` (rendered raw via
    // dangerouslySetInnerHTML), so a `</script>` in a (Spotify-sourced) artist name
    // can't break out of the <script> (stored-XSS sink, security review).
    scripts: [jsonLdScript(collectionPage)],
  };
}

// Route options follow TanStack's create-route-property-order (params → validateSearch →
// loaderDeps → loader → head → component); each step feeds the next's inferred types, so the order
// isn't alphabetical and sort-keys is off here.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/artists/")({
  validateSearch: (search: Record<string, unknown>): ArtistsSearch => ({
    page: pageParam(search["page"]),
  }),
  loaderDeps: ({ search }) => ({ page: search.page }),
  loader: async ({ deps }): Promise<ArtistsPageData> => {
    const data = await fetchArtistsPage({ data: { page: deps.page } });

    if (data.status === "missing") {
      throw notFound();
    }

    return data;
  },
  head: ({ loaderData }: { loaderData?: ArtistsPageData }) => artistsHead(loaderData),
  component: ArtistsPage,
  notFoundComponent: StoryNotFoundState,
});

type ArtistsSearch = { page?: number };

/** A page param the reader typed: junk or an absent value folds to undefined (the param-free view). */
function pageParam(value: unknown): number | undefined {
  const n = Number(value);

  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : undefined;
}

function ArtistsPage() {
  const data = Route.useLoaderData();

  if (data.status !== "found") {
    return null;
  }

  const { catalogue, findings, letters } = data;
  const buildHref = (page: number) => (page <= 1 ? "/artists" : `/artists?page=${page}`);
  const lane = <HubLetterLane buildHref={buildHref} label="Artists A to Z" letters={letters} />;
  const renderTile = (artist: ArtistCatalogueEntry) => (
    <li key={artist.slug}>
      <Link params={{ slug: artist.slug }} to="/artist/$slug">
        <ArtistAvatar className="artist-card-avatar" name={artist.name} src={artist.imageUrl} />
        <span className="artist-grid-line">{artist.name}</span>
        <span className="artist-grid-count">{tracksCount(artist.trackCount)}</span>
      </Link>
    </li>
  );

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <h1 className="log-coordinate log-index-title">Artists</h1>
          <p className="log-index-intro">
            Every drum &amp; bass artist with a finding in the archive. {findings.length} logged.
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

        <CatalogueHubPageSection
          gridClassName="artist-avatar-grid"
          heading="More artists"
          headingId="artists-catalogue-heading"
          items={catalogue.items}
          lane={lane}
          listLabel="More artists"
          pager={
            <CataloguePager
              buildHref={buildHref}
              label="More artists, more pages"
              page={catalogue.page}
              pageCount={catalogue.pageCount}
            />
          }
          renderTile={renderTile}
        />

        <footer className="log-plate-footer">
          <Link to="/">Back to the archive</Link>
          <Link to="/log">The full log</Link>
        </footer>
      </article>
    </main>
  );
}
