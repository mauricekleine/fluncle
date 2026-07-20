import { Link, createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { CataloguePager } from "@/components/catalogue-groups";
import { HubSearchInput } from "@/components/hub-search-input";
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
// A NAME SEARCH (`?q=`) narrows the index SQL-side (the shared hub gate stays single-sourced): the
// bare hub is indexable + in the sitemap, but any `?q=` present flips it to noindex (the /tracks
// filter rule) and drops the whole-index count on the masthead for a count-free line. Albums have NO
// A–Z lane — an album's identity is its cover, not a title-initial — so the numbered `?page=N` pager
// IS the album index's crawl entry into the long tail. Every page — page 1 included — SSRs one static
// slice of tiles behind a real-anchor pager. A page past the end 404s — never a clamp to page 1.

const countFormatter = new Intl.NumberFormat("en-US");

type AlbumsPageData =
  | {
      hub: CatalogueHubNumberedPage<AlbumHubEntry>;
      page: number;
      /** The active name search, or undefined on the bare hub — the filtered/noindex bit keys off it. */
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

  // A name search is a sliced view of the one hub: it collapses onto the bare `/albums` canonical and
  // goes `noindex, follow` (the /tracks filter rule). A clean paged view is its own canonical and
  // real content — noindex NEVER.
  const filtered = loaderData.q !== undefined;
  const canonical =
    filtered || loaderData.page <= 1
      ? `${siteUrl}/albums`
      : `${siteUrl}/albums?page=${loaderData.page}`;

  const meta = pagedMeta(filtered ? 1 : loaderData.page);
  const metaTags = [
    { title: meta.title },
    { content: meta.description, name: "description" },
    { content: meta.title, property: "og:title" },
    { content: meta.description, property: "og:description" },
    { content: `${siteUrl}/fluncle-cover.png`, property: "og:image" },
    { content: canonical, property: "og:url" },
    { content: "summary_large_image", name: "twitter:card" },
    { content: meta.title, name: "twitter:title" },
    { content: meta.description, name: "twitter:description" },
  ];

  if (filtered) {
    metaTags.push({ content: "noindex, follow", name: "robots" });

    return { links: [{ href: canonical, rel: "canonical" }], meta: metaTags };
  }

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
    q: qParam(search["q"]),
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

/** A page param the reader typed: junk or an absent value folds to undefined (the param-free view). */
function pageParam(value: unknown): number | undefined {
  const n = Number(value);

  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : undefined;
}

/** A trimmed non-empty name search; empty / non-string folds to undefined (the bare hub). */
function qParam(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

// One composed string (not JSX fragments) so the count is a single SSR text node. The count clause
// drops at ≤ 1 ("1 drum & bass records" is not a sentence).
function mastheadLine(total: number): string {
  return total > 1
    ? `${countFormatter.format(total)} drum & bass records, A to Z.`
    : "Drum & bass records, A to Z.";
}

/** "1 match" / "312 matches" — the count a name search holds, by the form when it is active. */
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
          {/* On a filtered view the count drops — the whole-index total would mis-caption a slice, so
              the matchline below owns that number (the /tracks rule). ONE composed string. */}
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

/** Build an `/albums?…` href preserving the active name search across pages (page 1 drops `page`). */
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
