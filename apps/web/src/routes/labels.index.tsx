import { Link, createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { CataloguePager } from "@/components/catalogue-groups";
import { HubLetterLane } from "@/components/catalogue-hub-section";
import { HubSearchInput } from "@/components/hub-search-input";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { TrackArtwork } from "@/components/track-artwork";
import { siteUrl } from "@/lib/fluncle-links";
import { tracksCount } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { albumCoverAtSize, COVER_TILE_SIZE } from "@/lib/media";
import {
  type CatalogueHubNumberedPage,
  type LabelHubEntry,
  listLabelsHubPage,
} from "@/lib/server/labels";

// The labels index: ONE alphabetical index of every record label Fluncle holds — the certified
// findings and the wider catalogue he is charting — cover-led, each tile linking to its
// `/label/<slug>` page (the internal-link hub that keeps those pages from being orphans). A
// certified label's name takes the certification light (DESIGN.md's Unlit Rule, Eclipse Gold); an
// uncertified one keeps the plain ink. The distinction is visual only — no badge, no tier heading,
// no finding count.
//
// A NAME SEARCH (`?q=`) narrows the index SQL-side (the shared hub gate stays single-sourced): the
// bare hub is indexable + in the sitemap, but any `?q=` present flips it to noindex (the /tracks
// filter rule), drops the whole-index count on the masthead for a count-free line, and hides the A–Z
// lane (searching by name is not browsing the alphabet). The page is BLIND to a label's crawl
// `seed_state`: that is crawl scope, never storage, and no read here knows it exists. Every page —
// page 1 included — SSRs one static slice of tiles behind a real-anchor `?page=N` pager, with an A–Z
// fast lane linking every region of the alphabet, so the whole index is reachable by internal links.

const countFormatter = new Intl.NumberFormat("en-US");

type LabelsPageData =
  | {
      hub: CatalogueHubNumberedPage<LabelHubEntry>;
      page: number;
      /** The active name search, or undefined on the bare hub — the filtered/noindex bit keys off it. */
      q: string | undefined;
      status: "found";
    }
  | { status: "missing" };

async function resolveLabelsPage(
  page: number | undefined,
  q: string | undefined,
): Promise<LabelsPageData> {
  const requested = page ?? 1;
  const hub = await listLabelsHubPage(requested, q);

  if (requested > hub.pageCount) {
    return { status: "missing" };
  }

  return { hub, page: requested, q, status: "found" };
}

const fetchLabelsPage = createServerFn({ method: "GET" })
  .validator((data: { page?: number; q?: string }) => data)
  .handler(({ data }): Promise<LabelsPageData> => resolveLabelsPage(data.page, data.q));

// Machine-facing strings stay honestly-plain third-person (the Narrator rule), and they carry the
// genre keyword — Bing flagged the hub layer for short, keyword-free titles and identical paged
// meta (2026-07-18). Paged variants bake their page number into BOTH strings.
const title = "Every drum & bass record label, A to Z · Fluncle";
const description =
  "Every drum & bass record label Fluncle holds, A to Z, with the founding facts and lineage that link them.";

function pagedMeta(page: number): { description: string; title: string } {
  if (page <= 1) {
    return { description, title };
  }

  return {
    description: `Page ${page} of every drum & bass record label Fluncle holds, A to Z.`,
    title: `Every drum & bass record label, page ${page} · Fluncle`,
  };
}

function labelsHead(loaderData: LabelsPageData | undefined) {
  if (loaderData?.status !== "found") {
    return {};
  }

  // A name search is a sliced view of the one hub: it collapses onto the bare `/labels` canonical and
  // goes `noindex, follow` (the /tracks filter rule) so a crawler indexes the hub, not the search
  // permutations. A clean paged view is its own canonical and real content — noindex NEVER.
  const filtered = loaderData.q !== undefined;
  const canonical =
    filtered || loaderData.page <= 1
      ? `${siteUrl}/labels`
      : `${siteUrl}/labels?page=${loaderData.page}`;

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

    // A filtered view is noindexed, so its CollectionPage would be structured-data noise — clean
    // pages only carry the JSON-LD.
    return { links: [{ href: canonical, rel: "canonical" }], meta: metaTags };
  }

  // The ItemList carries the page's tiles — every one a real `/label/<slug>` page — as the
  // `mainEntity` of a `CollectionPage`, carrying `numberOfItems` so the list's size is machine-
  // readable.
  const labels = loaderData.hub.items;
  const collectionPage = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    mainEntity: {
      "@type": "ItemList",
      itemListElement: labels.map((label, index) => ({
        "@type": "ListItem",
        name: label.name,
        position: index + 1,
        url: `${siteUrl}/label/${encodeURIComponent(label.slug)}`,
      })),
      numberOfItems: loaderData.hub.total,
    },
    name: "Every drum & bass record label Fluncle holds",
    url: `${siteUrl}/labels`,
  };

  return {
    links: [{ href: canonical, rel: "canonical" }],
    meta: metaTags,
    // JSON-LD goes through `jsonLdScript`, which HTML-escapes the serialized payload before
    // it reaches the inline <script>, so a `</script>` in a vendor-sourced label name can't
    // break out (stored-XSS sink, security review).
    scripts: [jsonLdScript(collectionPage)],
  };
}

// oxlint-disable-next-line sort-keys -- TanStack canonical property order (validateSearch → head); see AGENTS.md
export const Route = createFileRoute("/labels/")({
  validateSearch: (search: Record<string, unknown>): LabelsSearch => ({
    page: pageParam(search["page"]),
    q: qParam(search["q"]),
  }),
  loaderDeps: ({ search }) => ({ page: search.page, q: search.q }),
  loader: async ({ deps }): Promise<LabelsPageData> => {
    const data = await fetchLabelsPage({ data: { page: deps.page, q: deps.q } });

    if (data.status === "missing") {
      throw notFound();
    }

    return data;
  },
  head: ({ loaderData }: { loaderData?: LabelsPageData }) => labelsHead(loaderData),
  component: LabelsPage,
  notFoundComponent: StoryNotFoundState,
});

type LabelsSearch = { page?: number; q?: string };

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
// drops at ≤ 1 ("1 drum & bass labels" is not a sentence).
function mastheadLine(total: number): string {
  return total > 1
    ? `${countFormatter.format(total)} drum & bass labels, A to Z.`
    : "Drum & bass labels, A to Z.";
}

/** "1 match" / "312 matches" — the count a name search holds, by the form when it is active. */
function matchCount(count: number): string {
  return `${countFormatter.format(count)} ${count === 1 ? "match" : "matches"}`;
}

function LabelsPage() {
  const data = Route.useLoaderData();
  const navigate = useNavigate();

  if (data.status !== "found") {
    return null;
  }

  const { hub, q } = data;
  const filtered = q !== undefined;
  const buildHref = (page: number) => buildLabelsHref(q, page);
  const showSearch = filtered || hub.total > 0;

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <h1 className="log-coordinate log-index-title">Labels</h1>
          {/* On a filtered view the count drops — the whole-index total would mis-caption a slice, so
              the matchline below owns that number (the /tracks rule). ONE composed string. */}
          <p className="log-index-intro">{mastheadLine(filtered ? 0 : hub.total)}</p>
        </header>

        {showSearch ? (
          <HubSearchInput
            label="Search labels by name"
            onSearch={(term) => void navigate({ search: { q: term }, to: "/labels" })}
            placeholder="Search labels"
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
            {filtered ? "No labels match that name." : "No drum & bass labels yet."}
          </p>
        ) : (
          <>
            {/* The A–Z lane is a browse aid; a name search has already narrowed the list, so it hides
                while searching (the loader skips computing it then). */}
            {filtered ? undefined : (
              <HubLetterLane
                buildHref={buildHref}
                label="Labels A to Z"
                letters={hub.letters ?? []}
              />
            )}
            <ul aria-label="Labels" className="artist-grid hub-grid">
              {hub.items.map((label) => (
                <li key={label.slug}>
                  <Link
                    className={label.certified ? "hub-tile-certified" : undefined}
                    params={{ slug: label.slug }}
                    to="/label/$slug"
                  >
                    <TrackArtwork
                      alt=""
                      className="artist-grid-cover"
                      src={
                        label.logoImageUrl ?? albumCoverAtSize(label.coverImageUrl, COVER_TILE_SIZE)
                      }
                    />
                    <span className="artist-grid-line">{label.name}</span>
                    <span className="artist-grid-count">{tracksCount(label.trackCount)}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <CataloguePager
              buildHref={buildHref}
              label="Labels, more pages"
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

/** Build a `/labels?…` href preserving the active name search across pages (page 1 drops `page`). */
function buildLabelsHref(q: string | undefined, page: number): string {
  const params = new URLSearchParams();

  if (q !== undefined) {
    params.set("q", q);
  }
  if (page > 1) {
    params.set("page", String(page));
  }

  const query = params.toString();

  return query ? `/labels?${query}` : "/labels";
}
