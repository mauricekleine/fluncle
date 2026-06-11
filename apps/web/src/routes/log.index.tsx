import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { siteUrl } from "@/lib/fluncle-links";
import { formatDate } from "@/lib/format";
import { artistTitleLine } from "@/lib/log-prose";
import { listTracks, type TrackListPage } from "@/lib/server/tracks";

// The log index: every finding in the Galaxy as a crawlable link to its
// coordinate page — the internal-link surface that keeps /log/<id> pages from
// being orphans (web-overhaul RFC §3). Text-first on purpose; the cover-led
// archive stays the homepage.

// One page for now (the archive is in the tens); revisit pagination when the
// log outgrows a single readable plate.
const logIndexLimit = 500;

const fetchLog = createServerFn({ method: "GET" }).handler(() =>
  listTracks({ limit: logIndexLimit }),
);

const title = "Fluncle: the log";
const description =
  "Every finding in Fluncle's log: one Log ID per track, the date it was found, and the coordinate page that decodes it.";

function logIndexHead(loaderData: TrackListPage | undefined) {
  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: loaderData?.tracks
      .filter((track) => track.logId)
      .map((track, index) => ({
        "@type": "ListItem",
        name: `${track.logId} · ${artistTitleLine(track)}`,
        position: index + 1,
        url: `${siteUrl}/log/${encodeURIComponent(track.logId as string)}`,
      })),
    name: "Fluncle's log",
    url: `${siteUrl}/log`,
  };

  return {
    links: [{ href: `${siteUrl}/log`, rel: "canonical" }],
    meta: [
      { title },
      { content: description, name: "description" },
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: `${siteUrl}/fluncle-cover.png`, property: "og:image" },
      { content: `${siteUrl}/log`, property: "og:url" },
    ],
    scripts: [{ children: JSON.stringify(itemList), type: "application/ld+json" }],
  };
}

export const Route = createFileRoute("/log/")({
  component: LogIndexPage,
  head: ({ loaderData }: { loaderData?: TrackListPage }) => logIndexHead(loaderData),
  loader: () => fetchLog(),
});

function LogIndexPage() {
  const page = Route.useLoaderData();
  const entries = page.tracks.filter((track) => track.logId);

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <p className="log-nameplate">Fluncle's Findings</p>
          <h1 className="log-coordinate log-index-title">The log</h1>
          <p className="log-index-intro">
            Every finding in the Galaxy, one coordinate per banger. {entries.length} logged so far.
          </p>
        </header>

        {entries.length === 0 ? (
          <p className="log-index-empty">No findings logged yet. Quiet sector tonight.</p>
        ) : (
          <ol className="log-index-list">
            {entries.map((track) => (
              <li className="log-index-row" key={track.trackId}>
                <Link
                  className="log-index-id"
                  params={{ logId: track.logId as string }}
                  to="/log/$logId"
                >
                  {track.logId}
                </Link>
                <Link
                  className="log-index-line"
                  params={{ logId: track.logId as string }}
                  to="/log/$logId"
                >
                  {artistTitleLine(track)}
                </Link>
                <time className="log-index-date" dateTime={track.addedAt}>
                  Found {formatDate(track.addedAt)}
                </time>
              </li>
            ))}
          </ol>
        )}

        <footer className="log-plate-footer">
          <Link to="/">Back to the archive</Link>
          <Link to="/about">What a Log ID is</Link>
        </footer>
      </article>
    </main>
  );
}
