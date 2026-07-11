import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { TrackArtwork } from "@/components/track-artwork";
import { siteUrl } from "@/lib/fluncle-links";
import { jsonLdScript } from "@/lib/json-ld";
import { spotifyAlbumImageAtSize } from "@/lib/media";
import { type LabelIndexEntry, listLabelsWithFindingCounts } from "@/lib/server/labels";

// The labels index: every imprint Fluncle has logged a finding off, cover-led, each linking
// to its `/label/<slug>` page — the internal-link hub that keeps the label pages from being
// orphans (the `/artists` index precedent).
//
// It lists a label because Fluncle FOUND something on it, never because the crawler may
// seed from it: `seed_state` is crawl scope, never storage, and no read on this page knows
// it exists.

const fetchLabels = createServerFn({ method: "GET" }).handler(() => listLabelsWithFindingCounts());

const title = "Fluncle: the labels";
const description = "Every record label Fluncle has found a banger on, mapped across the Galaxy.";

function labelsHead(loaderData: LabelIndexEntry[] | undefined) {
  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: loaderData?.map((label, index) => ({
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
  loader: () => fetchLabels(),
  head: ({ loaderData }: { loaderData?: LabelIndexEntry[] }) => labelsHead(loaderData),
});

function LabelsPage() {
  const labels = Route.useLoaderData();

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <p className="log-nameplate">Fluncle's Findings</p>
          <h1 className="log-coordinate log-index-title">Labels</h1>
          <p className="log-index-intro">
            Every imprint I've pulled a banger off. {labels.length} logged so far.
          </p>
        </header>

        {labels.length === 0 ? (
          <p className="log-index-empty empty-scanlines">No labels logged yet. Quiet sector.</p>
        ) : (
          <ul aria-label="Labels" className="artist-grid">
            {labels.map((label) => (
              <li key={label.slug}>
                <Link params={{ slug: label.slug }} to="/label/$slug">
                  <TrackArtwork
                    alt=""
                    className="artist-grid-cover"
                    src={spotifyAlbumImageAtSize(label.coverImageUrl, "large")}
                  />
                  <span className="artist-grid-line">{label.name}</span>
                  <span className="artist-grid-count">
                    {label.findingCount} {label.findingCount === 1 ? "finding" : "findings"}
                  </span>
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
