import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { CataloguePager } from "@/components/catalogue-groups";
import { CatalogueHubPageSection, HubLetterLane } from "@/components/catalogue-hub-section";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { TrackArtwork } from "@/components/track-artwork";
import { siteUrl } from "@/lib/fluncle-links";
import { findingsCount, tracksCount } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { albumCoverAtSize, COVER_TILE_SIZE } from "@/lib/media";
import {
  type CatalogueHubNumberedPage,
  type EditorialHubPage,
  type LabelCatalogueEntry,
  type LabelIndexEntry,
  listLabelsCataloguePage,
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
// has: the INDEXABLE findings-free labels the crawler minted a page for. Every page — page 1
// included — SSRs one static slice of tiles behind a real-anchor `?page=N` pager, with an A–Z fast
// lane linking every region of the alphabet — so the long tail is reachable by internal links (and
// the footer by everyone), not the sitemap alone.

type LabelsPageData =
  | {
      catalogue: CatalogueHubNumberedPage<LabelCatalogueEntry>;
      findings: EditorialHubPage<LabelIndexEntry>;
      page: number;
      status: "found";
    }
  | { status: "missing" };

// ONE `?page=N` walks BOTH sections: page N is slice N of the logged labels and slice N of the long
// tail, so the hub keeps a single pager and a single URL space however far the archive grows. The
// logged list runs out first, and from there the deeper pages are pure long tail. A page past the end
// of BOTH 404s — never a clamp to page 1, which would be a second URL for page 1's tiles. The A–Z
// lane now rides on the long-tail read itself, off the same single scan.
async function resolveLabelsPage(page: number | undefined): Promise<LabelsPageData> {
  const requested = page ?? 1;
  const [catalogue, findings] = await Promise.all([
    listLabelsCataloguePage(requested),
    listLabelsWithFindingCounts(requested),
  ]);

  if (requested > Math.max(catalogue.pageCount, findings.pageCount)) {
    return { status: "missing" };
  }

  return { catalogue, findings, page: requested, status: "found" };
}

const fetchLabelsPage = createServerFn({ method: "GET" })
  .validator((data: { page?: number }) => data)
  .handler(({ data }): Promise<LabelsPageData> => resolveLabelsPage(data.page));

// Machine-facing strings stay honestly-plain third-person (the Narrator rule), and they carry the
// genre keyword — Bing flagged the hub layer for short, keyword-free titles and identical paged
// meta (2026-07-18). Paged variants bake their page number into BOTH strings.
const title = "Drum & bass record labels, A to Z · Fluncle";
const description =
  "Every drum & bass record label Fluncle has found a banger on, A to Z: the imprints behind the findings, with the founding facts and lineage that link them.";

function pagedMeta(page: number): { description: string; title: string } {
  if (page <= 1) {
    return { description, title };
  }

  return {
    description: `Page ${page} of every drum & bass record label Fluncle has found a banger on, A to Z: the imprints behind the findings.`,
    title: `Drum & bass record labels, page ${page} · Fluncle`,
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

  // The ItemList stays Fluncle's CURATED list (the findings section only): the catalogue entities'
  // pages are already carried by the sitemap, and the hub's structured data should mirror what the
  // hub is editorially about, never balloon to catalogue size. It rides as the `mainEntity` of a
  // `CollectionPage`, carrying `numberOfItems` so the list's size is machine-readable.
  const labels = loaderData.findings.items;
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

function LabelsPage() {
  const data = Route.useLoaderData();

  if (data.status !== "found") {
    return null;
  }

  const { catalogue, findings } = data;
  const buildHref = (page: number) => (page <= 1 ? "/labels" : `/labels?page=${page}`);
  const pageCount = Math.max(catalogue.pageCount, findings.pageCount);
  const lane = (
    <HubLetterLane buildHref={buildHref} label="Labels A to Z" letters={catalogue.letters ?? []} />
  );
  // ONE pager for the whole hub. It rides inside the long-tail section as before — but that section
  // renders nothing when its slice is empty, and the logged list can still have pages left there, so
  // the same pager is rendered on its own in that case rather than stranding the reader.
  const pager = (
    <CataloguePager
      buildHref={buildHref}
      label="More labels, more pages"
      page={data.page}
      pageCount={pageCount}
    />
  );
  const renderTile = (label: LabelCatalogueEntry) => (
    <li key={label.slug}>
      <Link params={{ slug: label.slug }} to="/label/$slug">
        <TrackArtwork
          alt=""
          className="artist-grid-cover"
          src={label.logoImageUrl ?? albumCoverAtSize(label.coverImageUrl, COVER_TILE_SIZE)}
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
            Every drum &amp; bass label with a finding in the archive. {findings.total} logged.
          </p>
        </header>

        {findings.total === 0 ? (
          <p className="log-index-empty empty-scanlines">No labels logged yet. Quiet sector.</p>
        ) : findings.items.length > 0 ? (
          <ul aria-label="Labels" className="artist-grid">
            {findings.items.map((label) => (
              <li key={label.slug}>
                <Link params={{ slug: label.slug }} to="/label/$slug">
                  <TrackArtwork
                    alt=""
                    className="artist-grid-cover"
                    src={
                      label.logoImageUrl ?? albumCoverAtSize(label.coverImageUrl, COVER_TILE_SIZE)
                    }
                  />
                  <span className="artist-grid-line">{label.name}</span>
                  <span className="artist-grid-count">{findingsCount(label.findingCount)}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}

        <CatalogueHubPageSection
          gridClassName="artist-grid"
          heading="More labels"
          headingId="labels-catalogue-heading"
          items={catalogue.items}
          lane={lane}
          listLabel="More labels"
          pager={pager}
          renderTile={renderTile}
        />

        {catalogue.items.length === 0 ? pager : null}

        <footer className="log-plate-footer">
          <Link to="/">Back to the archive</Link>
          <Link to="/log">The full log</Link>
        </footer>
      </article>
    </main>
  );
}
