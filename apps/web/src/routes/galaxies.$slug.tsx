import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { GraphLink } from "@/components/graph-link";
import { FindingsGridList } from "@/components/graph-sections";
import { galaxyIntroLine } from "@/lib/graph-prose";
import { galaxySoundLine } from "@/lib/galaxy-sound";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { siteUrl } from "@/lib/fluncle-links";
import { findingsCount } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { galaxyBreadcrumbsJsonLd, musicPlaylistJsonLd } from "@/lib/log-schema";
import { albumCoverAtSize } from "@/lib/media";
import { GALAXY_INDEX_MIN_FINDINGS } from "@/lib/galaxies";
import { type GalaxyListItem, type TrackListItem } from "@fluncle/contracts";

const GALAXY_PAGE_LIMIT = 60;

type GalaxyPageData = {
  adjacent: GalaxyListItem[];
  findings: TrackListItem[];
  galaxy: GalaxyListItem;
};

const fetchGalaxy = createServerFn({ method: "GET" })
  .validator((data: { slug: string }) => data)
  .handler(async ({ data: { slug } }): Promise<GalaxyPageData | null> => {
    const { getGalaxyLensPage } = await import("@/lib/server/galaxies-map");

    return getGalaxyLensPage(slug, GALAXY_PAGE_LIMIT, 0);
  });

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
    (coverFinding ? albumCoverAtSize(coverFinding.albumImageUrl, "large") : undefined) ??
    `${siteUrl}/fluncle-cover.png`;

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

    scripts: [jsonLdScript(playlist), jsonLdScript(galaxyBreadcrumbsJsonLd(galaxy.name))],
  };
}

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/galaxies/$slug")({
  loader: async ({ params }): Promise<GalaxyPageData> => {
    const data = await fetchGalaxy({ data: { slug: params.slug } });

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
  const sound = galaxySoundLine(galaxy.slug);

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <p className="log-nameplate">Fluncle's Findings</p>
          <h1 className="log-coordinate log-index-title galaxy-title">{galaxy.name}</h1>
          {sound ? <p className="log-index-intro">{sound}</p> : undefined}
          <p className="log-index-intro">{galaxyIntroLine(galaxy.memberCount)}</p>
        </header>

        {grid.length === 0 ? (
          <p className="log-index-empty empty-scanlines">
            No findings logged yet. Quiet sector tonight.
          </p>
        ) : (
          <FindingsGridList
            className="artist-grid"
            findings={grid}
            label={`Findings in the ${galaxy.name} galaxy`}
            priorityFirst={false}
            size="large"
          />
        )}

        {adjacent.length > 0 ? (
          <nav aria-label="Adjacent galaxies" className="galaxy-adjacent">
            <p className="artist-similar-label">Close in sound</p>
            <ul className="galaxy-adjacent-list">
              {adjacent.map((neighbour) => (
                <li key={neighbour.slug}>
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
          <Link to="/findings">Back to the archive</Link>
        </footer>
      </article>
    </main>
  );
}
