import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { CataloguePager } from "@/components/catalogue-groups";
import { HubLetterLane } from "@/components/catalogue-hub-section";
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
// The page is BLIND to a label's crawl `seed_state`: that is crawl scope, never storage, and no
// read here knows it exists. Every page — page 1 included — SSRs one static slice of tiles behind a
// real-anchor `?page=N` pager, with an A–Z fast lane linking every region of the alphabet, so the
// whole index is reachable by internal links (and the footer by everyone), not the sitemap alone.

const countFormatter = new Intl.NumberFormat("en-US");

type LabelsPageData =
  | {
      hub: CatalogueHubNumberedPage<LabelHubEntry>;
      page: number;
      status: "found";
    }
  | { status: "missing" };

async function resolveLabelsPage(page: number | undefined): Promise<LabelsPageData> {
  const requested = page ?? 1;
  const hub = await listLabelsHubPage(requested);

  if (requested > hub.pageCount) {
    return { status: "missing" };
  }

  return { hub, page: requested, status: "found" };
}

const fetchLabelsPage = createServerFn({ method: "GET" })
  .validator((data: { page?: number }) => data)
  .handler(({ data }): Promise<LabelsPageData> => resolveLabelsPage(data.page));

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

  // Self-referencing PER PAGE: `?page=N` is its own canonical, page 1 stays the bare `/labels`. The
  // paged variants are real content — `noindex` NEVER.
  const canonical =
    loaderData.page > 1 ? `${siteUrl}/labels?page=${loaderData.page}` : `${siteUrl}/labels`;

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
  }),
  loaderDeps: ({ search }) => ({ page: search.page }),
  loader: async ({ deps }): Promise<LabelsPageData> => {
    const data = await fetchLabelsPage({ data: { page: deps.page } });

    if (data.status === "missing") {
      throw notFound();
    }

    return data;
  },
  head: ({ loaderData }: { loaderData?: LabelsPageData }) => labelsHead(loaderData),
  component: LabelsPage,
  notFoundComponent: StoryNotFoundState,
});

type LabelsSearch = { page?: number };

/** A page param the reader typed: junk or an absent value folds to undefined (the param-free view). */
function pageParam(value: unknown): number | undefined {
  const n = Number(value);

  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : undefined;
}

// One composed string (not JSX fragments) so the count is a single SSR text node. The count clause
// drops at ≤ 1 ("all 1 of them" is not a sentence).
function mastheadLine(total: number): string {
  return total > 1
    ? `Every drum & bass label Fluncle holds, all ${countFormatter.format(total)} of them.`
    : "Every drum & bass label Fluncle holds.";
}

function LabelsPage() {
  const data = Route.useLoaderData();

  if (data.status !== "found") {
    return null;
  }

  const { hub } = data;
  const buildHref = (page: number) => (page <= 1 ? "/labels" : `/labels?page=${page}`);

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <h1 className="log-coordinate log-index-title">Labels</h1>
          <p className="log-index-intro">{mastheadLine(hub.total)}</p>
        </header>

        {hub.total === 0 ? (
          <p className="log-index-empty empty-scanlines">No drum &amp; bass labels yet.</p>
        ) : (
          <>
            <HubLetterLane
              buildHref={buildHref}
              label="Labels A to Z"
              letters={hub.letters ?? []}
            />
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
