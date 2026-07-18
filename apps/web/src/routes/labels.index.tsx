import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { CataloguePager } from "@/components/catalogue-groups";
import {
  CatalogueHubPageSection,
  CatalogueHubSection,
  HubLetterLane,
} from "@/components/catalogue-hub-section";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { TrackArtwork } from "@/components/track-artwork";
import { siteUrl } from "@/lib/fluncle-links";
import { findingsCount, tracksCount } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { albumCoverAtSize } from "@/lib/media";
import {
  CATALOGUE_HUB_DEFAULT_LIMIT,
  type CatalogueHubLetter,
  type CatalogueHubNumberedPage,
  CatalogueHubPageOutOfRangeError,
  type CatalogueHubPage,
  type LabelCatalogueEntry,
  type LabelIndexEntry,
  listLabelsCatalogue,
  listLabelsCataloguePage,
  listLabelsCatalogueLetters,
  listLabelsWithFindingCounts,
} from "@/lib/server/labels";

// The labels index: every label Fluncle has logged a finding off, cover-led, each linking to
// its `/label/<slug>` page — the internal-link hub that keeps those pages from being orphans
// (the `/artists` index precedent).
//
// It lists a label because Fluncle FOUND something on it, never because the crawler may seed
// from it: `seed_state` is crawl scope, never storage, and no read on this page knows it
// exists.
//
// This TOP section is deliberately NARROWER than the sitemap — Fluncle's own editorial list, "every
// label I've pulled a banger off". Below it, "More labels" carries the other half the sitemap always
// has: the INDEXABLE findings-free labels the crawler minted a page for. The param-free `/labels`
// streams them in on scroll (the human read); a crawlable `?page=N` variant SSRs each page's tiles
// behind a real-anchor pager, and an A–Z fast lane links every region of the alphabet — so the long
// tail is reachable by internal links, not the sitemap alone.

type LabelsCatalogue =
  | { mode: "page"; page: CatalogueHubNumberedPage<LabelCatalogueEntry> }
  | { mode: "scroll"; seed: CatalogueHubPage<LabelCatalogueEntry> };

type LabelsPageData =
  | {
      catalogue: LabelsCatalogue;
      findings: LabelIndexEntry[];
      letters: CatalogueHubLetter[];
      page: number;
      status: "found";
    }
  | { status: "missing" };

async function resolveLabelsPage(page: number | undefined): Promise<LabelsPageData> {
  if (page !== undefined && page > 1) {
    const [paged, findings, letters] = await Promise.all([
      listLabelsCataloguePage(page).catch((error: unknown) => {
        if (error instanceof CatalogueHubPageOutOfRangeError) {
          return null;
        }

        throw error;
      }),
      listLabelsWithFindingCounts(),
      listLabelsCatalogueLetters(),
    ]);

    if (paged === null) {
      return { status: "missing" };
    }

    return { catalogue: { mode: "page", page: paged }, findings, letters, page, status: "found" };
  }

  const [findings, seed, letters] = await Promise.all([
    listLabelsWithFindingCounts(),
    listLabelsCatalogue({ limit: CATALOGUE_HUB_DEFAULT_LIMIT }),
    listLabelsCatalogueLetters(),
  ]);

  return { catalogue: { mode: "scroll", seed }, findings, letters, page: 1, status: "found" };
}

const fetchLabelsPage = createServerFn({ method: "GET" })
  .validator((data: { page?: number }) => data)
  .handler(({ data }): Promise<LabelsPageData> => resolveLabelsPage(data.page));

// Subsequent "more labels" scroll pages go through the SAME serverFn the loader seeded from —
// a slug keyset, no oRPC op (the homepage-feed precedent).
const fetchLabelsCatalogue = createServerFn({ method: "GET" })
  .validator((data: { cursor?: string; limit?: number }) => data)
  .handler(({ data }) => listLabelsCatalogue({ cursor: data.cursor, limit: data.limit }));

const title = "Fluncle: the labels";
const description = "Every record label Fluncle has found a banger on, mapped across the Galaxy.";

function labelsHead(loaderData: LabelsPageData | undefined) {
  if (loaderData?.status !== "found") {
    return {};
  }

  // Self-referencing PER PAGE: `?page=N` is its own canonical, page 1 stays the bare `/labels`. The
  // paged variants are real content — `noindex` NEVER.
  const canonical =
    loaderData.page > 1 ? `${siteUrl}/labels?page=${loaderData.page}` : `${siteUrl}/labels`;

  // The ItemList stays Fluncle's CURATED list (the findings section only): the catalogue entities'
  // pages are already carried by the sitemap, and the hub's structured data should mirror what the
  // hub is editorially about, never balloon to catalogue size. It rides as the `mainEntity` of a
  // `CollectionPage`, carrying `numberOfItems` so the list's size is machine-readable.
  const labels = loaderData.findings;
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
      numberOfItems: labels.length,
    },
    name: "Fluncle's labels",
    url: `${siteUrl}/labels`,
  };

  return {
    links: [{ href: canonical, rel: "canonical" }],
    meta: [
      { title },
      { content: description, name: "description" },
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: `${siteUrl}/fluncle-cover.png`, property: "og:image" },
      { content: canonical, property: "og:url" },
      { content: "summary_large_image", name: "twitter:card" },
      { content: title, name: "twitter:title" },
      { content: description, name: "twitter:description" },
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

function LabelsPage() {
  const data = Route.useLoaderData();

  if (data.status !== "found") {
    return null;
  }

  const { catalogue, findings, letters } = data;
  const buildHref = (page: number) => (page <= 1 ? "/labels" : `/labels?page=${page}`);
  const lane = <HubLetterLane buildHref={buildHref} label="Labels A to Z" letters={letters} />;
  const renderTile = (label: LabelCatalogueEntry) => (
    <li key={label.slug}>
      <Link params={{ slug: label.slug }} to="/label/$slug">
        <TrackArtwork
          alt=""
          className="artist-grid-cover"
          src={label.logoImageUrl ?? albumCoverAtSize(label.coverImageUrl, "large")}
        />
        <span className="artist-grid-line">{label.name}</span>
        <span className="artist-grid-count">{tracksCount(label.trackCount)}</span>
      </Link>
    </li>
  );

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <h1 className="log-coordinate log-index-title">Labels</h1>
          <p className="log-index-intro">
            Every drum &amp; bass label with a finding in the archive. {findings.length} logged.
          </p>
        </header>

        {findings.length === 0 ? (
          <p className="log-index-empty empty-scanlines">No labels logged yet. Quiet sector.</p>
        ) : (
          <ul aria-label="Labels" className="artist-grid">
            {findings.map((label) => (
              <li key={label.slug}>
                <Link params={{ slug: label.slug }} to="/label/$slug">
                  <TrackArtwork
                    alt=""
                    className="artist-grid-cover"
                    src={label.logoImageUrl ?? albumCoverAtSize(label.coverImageUrl, "large")}
                  />
                  <span className="artist-grid-line">{label.name}</span>
                  <span className="artist-grid-count">{findingsCount(label.findingCount)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {catalogue.mode === "scroll" ? (
          <CatalogueHubSection
            gridClassName="artist-grid"
            heading="More labels"
            headingId="labels-catalogue-heading"
            initialPage={catalogue.seed}
            lane={lane}
            listLabel="More labels"
            queryFn={(cursor) =>
              fetchLabelsCatalogue({ data: { cursor, limit: CATALOGUE_HUB_DEFAULT_LIMIT } })
            }
            queryKey="labels-catalogue"
            renderTile={renderTile}
          />
        ) : (
          <CatalogueHubPageSection
            gridClassName="artist-grid"
            heading="More labels"
            headingId="labels-catalogue-heading"
            items={catalogue.page.items}
            lane={lane}
            listLabel="More labels"
            pager={
              <CataloguePager
                buildHref={buildHref}
                label="More labels, more pages"
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
