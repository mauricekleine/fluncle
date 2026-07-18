import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { TrackArtwork } from "@/components/track-artwork";
import { siteUrl } from "@/lib/fluncle-links";
import { findingsCount } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { albumCoverAtSize } from "@/lib/media";
import { type GalaxyPane, listGalaxyPanes } from "@/lib/server/galaxies-map";

// The /galaxies index (browse-by-feel RFC, Slice 4): the sonic map of the archive —
// every operator-named galaxy as a quiet, cover-led pane you enter, not a facet you
// toggle (DESIGN.md Don't: no chips, no streaming-app clone). The clusters ARE the
// galaxies: k-means regions over the MuQ embedding space. Held behind the launch gate —
// `listGalaxyPanes` returns [] until the WHOLE map is named, and an empty map 404s here,
// so nothing public renders a galaxy until the operator finishes naming (decision 5).

// A few covers per pane — enough to read as a place, not a whole cluster dump.
const PANE_COVER_CAP = 5;

const fetchGalaxyPanes = createServerFn({ method: "GET" }).handler(() =>
  listGalaxyPanes(PANE_COVER_CAP),
);

const title = "The sonic galaxies of drum & bass · Fluncle";
const description =
  "Every finding in the Galaxy, grouped by how it hits. Wander the sonic galaxies of Fluncle's Findings.";

function galaxiesHead(loaderData: GalaxyPane[] | undefined) {
  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: loaderData?.map((galaxy, index) => ({
      "@type": "ListItem",
      name: galaxy.name,
      position: index + 1,
      url: `${siteUrl}/galaxies/${encodeURIComponent(galaxy.slug)}`,
    })),
    name: "Fluncle's galaxies",
    url: `${siteUrl}/galaxies`,
  };

  return {
    links: [{ href: `${siteUrl}/galaxies`, rel: "canonical" }],
    meta: [
      { title },
      { content: description, name: "description" },
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: `${siteUrl}/fluncle-cover.png`, property: "og:image" },
      { content: `${siteUrl}/galaxies`, property: "og:url" },
    ],
    // JSON-LD through `jsonLdScript`, which HTML-escapes the serialized payload before
    // it reaches the inline <script> (a `</script>` in an operator-authored galaxy name
    // can't break out — the same stored-XSS guard the artists index uses).
    scripts: [jsonLdScript(itemList)],
  };
}

// oxlint-disable-next-line sort-keys -- TanStack canonical property order (loader before head); see AGENTS.md
export const Route = createFileRoute("/galaxies/")({
  loader: async (): Promise<GalaxyPane[]> => {
    const panes = await fetchGalaxyPanes();

    // Empty = the launch gate is still closed (the map isn't fully named). Nothing
    // public renders a galaxy until then, so the index itself 404s (decision 5).
    if (panes.length === 0) {
      throw notFound();
    }

    return panes;
  },
  head: ({ loaderData }: { loaderData?: GalaxyPane[] }) => galaxiesHead(loaderData),
  component: GalaxiesPage,
  notFoundComponent: StoryNotFoundState,
});

function GalaxiesPage() {
  const galaxies = Route.useLoaderData();

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <p className="log-nameplate">Fluncle's Findings</p>
          <h1 className="log-coordinate log-index-title">Galaxies</h1>
          <p className="log-index-intro">
            Every finding in the Galaxy, grouped by how it hits. Wander the galaxies.
          </p>
        </header>

        <ul aria-label="Galaxies" className="galaxy-index-grid">
          {galaxies.map((galaxy) => (
            <li key={galaxy.slug}>
              <Link className="galaxy-pane" params={{ slug: galaxy.slug }} to="/galaxies/$slug">
                {galaxy.covers.length > 0 ? (
                  <span aria-hidden="true" className="galaxy-pane-covers">
                    {galaxy.covers.map((cover) => (
                      <TrackArtwork
                        alt=""
                        className="galaxy-pane-cover"
                        key={cover}
                        src={albumCoverAtSize(cover, "small")}
                      />
                    ))}
                  </span>
                ) : null}
                <span className="galaxy-pane-name">{galaxy.name}</span>
                <span className="galaxy-pane-count">{findingsCount(galaxy.memberCount)}</span>
              </Link>
            </li>
          ))}
        </ul>

        <footer className="log-plate-footer">
          <Link to="/">Back to the archive</Link>
          <Link to="/log">The full log</Link>
        </footer>
      </article>
    </main>
  );
}
