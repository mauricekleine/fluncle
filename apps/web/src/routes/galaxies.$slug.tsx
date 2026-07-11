import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { GraphLink } from "@/components/graph-link";
import { galaxyIntroLine } from "@/lib/graph-prose";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { TrackArtwork } from "@/components/track-artwork";
import { siteUrl } from "@/lib/fluncle-links";
import { findingsCount } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { galaxyBreadcrumbsJsonLd, musicPlaylistJsonLd } from "@/lib/log-schema";
import { artistTitleLine } from "@/lib/log-prose";
import { spotifyAlbumImageAtSize } from "@/lib/media";
import { GALAXY_INDEX_MIN_FINDINGS, getGalaxyLensPage } from "@/lib/server/galaxies-map";
import { type GalaxyListItem, type TrackListItem } from "@fluncle/contracts";

// One sonic galaxy's lens page (browse-by-feel RFC, Slice 4): the galaxy as a place you
// enter — its findings core-first (nearest the centroid first, the order a radio
// consumer needs), and an "adjacent galaxies" strip ranked by centroid cosine ("Close
// in sound" applied to galaxies themselves), so movement is spatial, never a filter.
// Held behind the launch gate: `getGalaxyLensPage` returns null (→ 404) until the whole
// map is named. A thin galaxy (< GALAXY_INDEX_MIN_FINDINGS members) still resolves but
// renders `noindex, follow` — the /artist thin-content gate, applied to galaxies.

// A generous single page of the core-first head — enough that every current member
// shows at the catalogue's scale; the contract paginates for API consumers past this.
const GALAXY_PAGE_LIMIT = 60;

type GalaxyPageData = {
  adjacent: GalaxyListItem[];
  findings: TrackListItem[];
  galaxy: GalaxyListItem;
};

const fetchGalaxy = createServerFn({ method: "GET" })
  .validator((data: { slug: string }) => data)
  .handler(
    ({ data: { slug } }): Promise<GalaxyPageData | null> =>
      getGalaxyLensPage(slug, GALAXY_PAGE_LIMIT, 0),
  );

function galaxyHead(loaderData: GalaxyPageData | null | undefined) {
  if (!loaderData) {
    return {};
  }

  const { findings, galaxy } = loaderData;
  const pageUrl = `${siteUrl}/galaxies/${galaxy.slug}`;
  const title = `${galaxy.name} · Fluncle's galaxies`;
  const description = `${galaxy.name}: ${galaxyIntroLine(galaxy.memberCount)} A sonic galaxy in Fluncle's Findings.`;
  const coverFinding = findings[0];
  const imageUrl =
    (coverFinding ? spotifyAlbumImageAtSize(coverFinding.albumImageUrl, "large") : undefined) ??
    `${siteUrl}/fluncle-cover.png`;
  // Thin-content gate: index only at ≥ GALAXY_INDEX_MIN_FINDINGS members; below that the
  // page still serves 200 but is noindex + out of the sitemap (the /artist precedent).
  const indexable = galaxy.memberCount >= GALAXY_INDEX_MIN_FINDINGS;

  const playlist = musicPlaylistJsonLd(
    galaxy,
    findings.flatMap((finding) =>
      finding.logId
        ? [{ artists: finding.artists, logId: finding.logId, title: finding.title }]
        : [],
    ),
  );

  return {
    links: [{ href: pageUrl, rel: "canonical" }],
    meta: [
      { title },
      { content: description, name: "description" },
      ...(indexable ? [] : [{ content: "noindex, follow", name: "robots" }]),
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: imageUrl, property: "og:image" },
      { content: pageUrl, property: "og:url" },
      { content: "summary_large_image", name: "twitter:card" },
      { content: title, name: "twitter:title" },
      { content: description, name: "twitter:description" },
      { content: imageUrl, name: "twitter:image" },
    ],
    // JSON-LD through `jsonLdScript` (HTML-escaped before the inline <script>) so a
    // `</script>` in an operator name or a Spotify-sourced title can't break out.
    scripts: [jsonLdScript(playlist), jsonLdScript(galaxyBreadcrumbsJsonLd(galaxy.name))],
  };
}

// Route options follow TanStack's create-route-property-order (each step feeds the
// next's inferred types), which isn't alphabetical — so sort-keys is off here.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/galaxies/$slug")({
  loader: async ({ params }): Promise<GalaxyPageData> => {
    const data = await fetchGalaxy({ data: { slug: params.slug } });

    // null = the launch gate is still closed OR the slug names no galaxy — both 404.
    if (!data) {
      throw notFound();
    }

    return data;
  },
  head: ({ loaderData }: { loaderData?: GalaxyPageData | null }) => galaxyHead(loaderData),
  component: GalaxyPage,
  notFoundComponent: StoryNotFoundState,
});

function GalaxyPage() {
  const { adjacent, findings, galaxy } = Route.useLoaderData();
  const grid = findings.filter((finding) => finding.logId);

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <p className="log-nameplate">Fluncle's Findings</p>
          <h1 className="log-coordinate log-index-title galaxy-title">{galaxy.name}</h1>
          <p className="log-index-intro">{galaxyIntroLine(galaxy.memberCount)}</p>
        </header>

        {grid.length === 0 ? (
          <p className="log-index-empty empty-scanlines">
            No findings logged yet. Quiet sector tonight.
          </p>
        ) : (
          <ul aria-label={`Findings in the ${galaxy.name} galaxy`} className="artist-grid">
            {grid.map((finding) =>
              finding.logId ? (
                <li key={finding.trackId}>
                  <Link params={{ logId: finding.logId }} to="/log/$logId">
                    <TrackArtwork
                      alt=""
                      className="artist-grid-cover"
                      src={spotifyAlbumImageAtSize(finding.albumImageUrl, "large")}
                    />
                    <span className="artist-grid-line">{artistTitleLine(finding)}</span>
                  </Link>
                </li>
              ) : null,
            )}
          </ul>
        )}

        {adjacent.length > 0 ? (
          <nav aria-label="Adjacent galaxies" className="galaxy-adjacent">
            <p className="artist-similar-label">Close in sound</p>
            <ul className="galaxy-adjacent-list">
              {adjacent.map((neighbour) => (
                <li key={neighbour.slug}>
                  {/* The same graph link, chip skin — the adjacent region previews before you
                      travel to it. */}
                  <GraphLink
                    className="galaxy-adjacent-link"
                    kind="galaxy"
                    slug={neighbour.slug}
                    variant="chip"
                  >
                    <span className="galaxy-adjacent-name">{neighbour.name}</span>
                    <span className="galaxy-adjacent-count">
                      {findingsCount(neighbour.memberCount)}
                    </span>
                  </GraphLink>
                </li>
              ))}
            </ul>
          </nav>
        ) : undefined}

        <footer className="log-plate-footer">
          <Link to="/galaxies">All galaxies</Link>
          <Link to="/">Back to the archive</Link>
        </footer>
      </article>
    </main>
  );
}
