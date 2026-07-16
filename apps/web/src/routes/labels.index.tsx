import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { CatalogueHubSection } from "@/components/catalogue-hub-section";
import { TrackArtwork } from "@/components/track-artwork";
import { siteUrl } from "@/lib/fluncle-links";
import { findingsCount, tracksCount } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { albumCoverAtSize } from "@/lib/media";
import {
  CATALOGUE_HUB_DEFAULT_LIMIT,
  type CatalogueHubPage,
  type LabelCatalogueEntry,
  type LabelIndexEntry,
  listLabelsCatalogue,
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
// label I've pulled a banger off". Below it, "Also in the catalogue" carries the other half the
// sitemap always has: the INDEXABLE findings-free labels the crawler minted a page for
// (`listLabelsCatalogue`), rendered UNLIT and never claimed as a finding.

type LabelsPageData = {
  catalogue: CatalogueHubPage<LabelCatalogueEntry>;
  findings: LabelIndexEntry[];
};

const fetchLabelsPage = createServerFn({ method: "GET" }).handler(
  async (): Promise<LabelsPageData> => {
    const [findings, catalogue] = await Promise.all([
      listLabelsWithFindingCounts(),
      listLabelsCatalogue({ limit: CATALOGUE_HUB_DEFAULT_LIMIT }),
    ]);

    return { catalogue, findings };
  },
);

// Subsequent "also in the catalogue" pages go through the SAME serverFn the loader seeded from —
// a slug keyset, no oRPC op (the homepage-feed precedent).
const fetchLabelsCatalogue = createServerFn({ method: "GET" })
  .validator((data: { cursor?: string; limit?: number }) => data)
  .handler(({ data }) => listLabelsCatalogue({ cursor: data.cursor, limit: data.limit }));

const title = "Fluncle: the labels";
const description = "Every record label Fluncle has found a banger on, mapped across the Galaxy.";

function labelsHead(loaderData: LabelsPageData | undefined) {
  // The ItemList stays Fluncle's CURATED list (the findings section only): the catalogue entities'
  // pages are already carried by the sitemap, and the hub's structured data should mirror what the
  // hub is editorially about, never balloon to catalogue size.
  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: loaderData?.findings.map((label, index) => ({
      "@type": "ListItem",
      name: label.name,
      position: index + 1,
      url: `${siteUrl}/label/${encodeURIComponent(label.slug)}`,
    })),
    name: "Fluncle's labels",
    url: `${siteUrl}/labels`,
  };

  return {
    links: [{ href: `${siteUrl}/labels`, rel: "canonical" }],
    meta: [
      { title },
      { content: description, name: "description" },
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: `${siteUrl}/fluncle-cover.png`, property: "og:image" },
      { content: `${siteUrl}/labels`, property: "og:url" },
    ],
    // JSON-LD goes through `jsonLdScript`, which HTML-escapes the serialized payload before
    // it reaches the inline <script>, so a `</script>` in a vendor-sourced label name can't
    // break out (stored-XSS sink, security review).
    scripts: [jsonLdScript(itemList)],
  };
}

// oxlint-disable-next-line sort-keys -- TanStack canonical property order (loader before head); see AGENTS.md
export const Route = createFileRoute("/labels/")({
  component: LabelsPage,
  loader: () => fetchLabelsPage(),
  head: ({ loaderData }: { loaderData?: LabelsPageData }) => labelsHead(loaderData),
});

function LabelsPage() {
  const { catalogue, findings } = Route.useLoaderData();

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <p className="log-nameplate">Fluncle's Findings</p>
          <h1 className="log-coordinate log-index-title">Labels</h1>
          <p className="log-index-intro">
            Every label I've pulled a banger off. {findings.length} logged so far.
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

        <CatalogueHubSection
          gridClassName="artist-grid"
          heading="More labels"
          headingId="labels-catalogue-heading"
          initialPage={catalogue}
          listLabel="More labels"
          queryFn={(cursor) =>
            fetchLabelsCatalogue({ data: { cursor, limit: CATALOGUE_HUB_DEFAULT_LIMIT } })
          }
          queryKey="labels-catalogue"
          renderTile={(label) => (
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
