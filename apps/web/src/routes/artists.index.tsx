import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { ArtistAvatar } from "@/components/artist-avatar";
import { CataloguePager } from "@/components/catalogue-groups";
import { HubLetterLane } from "@/components/catalogue-hub-section";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { siteUrl } from "@/lib/fluncle-links";
import { tracksCount } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { albumCoverAtSize, COVER_TILE_SIZE } from "@/lib/media";
import { type ArtistHubEntry, listArtistsHubPage } from "@/lib/server/artists";
import { type CatalogueHubNumberedPage } from "@/lib/server/labels";

// The artists index: ONE alphabetical index of every artist Fluncle holds — the certified findings
// and the wider catalogue he is charting — cover-led, each tile linking to its `/artist/<slug>`
// page (the internal-link hub that keeps the artist pages from being orphans). A certified artist's
// name takes the certification light (DESIGN.md's Unlit Rule, Eclipse Gold); an uncertified one
// keeps the plain ink. The distinction is visual only — no badge, no tier heading, no finding count.
//
// Every page — page 1 included — SSRs one static slice of tiles behind a real-anchor `?page=N`
// pager, with an A–Z fast lane linking every region of the alphabet, so the whole index is reachable
// by internal links (and the footer by everyone), not the sitemap alone.

const countFormatter = new Intl.NumberFormat("en-US");

type ArtistsPageData =
  | {
      hub: CatalogueHubNumberedPage<ArtistHubEntry>;
      // The current page (1 for the bare `/artists`) — the head's per-page canonical keys off it.
      page: number;
      status: "found";
    }
  | { status: "missing" };

// ONE read serves the whole index. A `?page=N` past the end returns an honest empty page, so the
// route 404s off `page > pageCount` rather than clamping to page 1 (which would be a second URL for
// page 1's tiles). Page 1 of an empty index is a legitimate empty page, never a 404.
async function resolveArtistsPage(page: number | undefined): Promise<ArtistsPageData> {
  const requested = page ?? 1;
  const hub = await listArtistsHubPage(requested);

  if (requested > hub.pageCount) {
    return { status: "missing" };
  }

  return { hub, page: requested, status: "found" };
}

const fetchArtistsPage = createServerFn({ method: "GET" })
  .validator((data: { page?: number }) => data)
  .handler(({ data }): Promise<ArtistsPageData> => resolveArtistsPage(data.page));

// Machine-facing strings stay honestly-plain third-person (the Narrator rule), and they carry the
// genre keyword: Bing flagged the hub layer for short titles + identical paged meta (2026-07-18).
// Paged variants bake their page number into BOTH strings so no two `?page=N` URLs share meta.
const title = "Every drum & bass artist, A to Z · Fluncle";
const description =
  "Every drum & bass artist Fluncle holds, A to Z, with the labels that pressed their records.";

function pagedMeta(page: number): { description: string; title: string } {
  if (page <= 1) {
    return { description, title };
  }

  return {
    description: `Page ${page} of every drum & bass artist Fluncle holds, A to Z.`,
    title: `Every drum & bass artist, page ${page} · Fluncle`,
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

  // The ItemList carries the page's tiles — every one is a real `/artist/<slug>` page — as the
  // `mainEntity` of a `CollectionPage`, with `numberOfItems` set to the whole index size so a
  // crawler knows the list's true size without counting.
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

// One composed string (not JSX fragments) so the count is a single SSR text node — a conditional
// clause SSRs as several nodes split by hydration markers, which a naive text extractor misreads.
// The count clause drops at ≤ 1 ("1 drum & bass artists" is not a sentence).
function mastheadLine(total: number): string {
  return total > 1
    ? `${countFormatter.format(total)} drum & bass artists, A to Z.`
    : "Drum & bass artists, A to Z.";
}

function ArtistsPage() {
  const data = Route.useLoaderData();

  if (data.status !== "found") {
    return null;
  }

  const { hub } = data;
  const buildHref = (page: number) => (page <= 1 ? "/artists" : `/artists?page=${page}`);

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <h1 className="log-coordinate log-index-title">Artists</h1>
          <p className="log-index-intro">{mastheadLine(hub.total)}</p>
        </header>

        {hub.total === 0 ? (
          <p className="log-index-empty empty-scanlines">No drum &amp; bass artists yet.</p>
        ) : (
          <>
            <HubLetterLane
              buildHref={buildHref}
              label="Artists A to Z"
              letters={hub.letters ?? []}
            />
            <ul aria-label="Artists" className="artist-avatar-grid hub-grid">
              {hub.items.map((artist) => (
                <li key={artist.slug}>
                  <Link
                    className={artist.certified ? "hub-tile-certified" : undefined}
                    params={{ slug: artist.slug }}
                    to="/artist/$slug"
                  >
                    <ArtistAvatar
                      className="artist-card-avatar"
                      name={artist.name}
                      src={albumCoverAtSize(artist.imageUrl, COVER_TILE_SIZE)}
                    />
                    <span className="artist-grid-line">{artist.name}</span>
                    <span className="artist-grid-count">{tracksCount(artist.trackCount)}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <CataloguePager
              buildHref={buildHref}
              label="Artists, more pages"
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
