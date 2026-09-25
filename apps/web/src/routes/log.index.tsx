import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { siteUrl } from "@/lib/fluncle-links";
import { formatDate } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { artistTitleLine } from "@/lib/log-prose";
import { listLogIndexEntries, type LogIndexEntry } from "@/lib/server/tracks";

const logIndexLimit = 500;

const fetchLog = createServerFn({ method: "GET" }).handler(() =>
  listLogIndexEntries(logIndexLimit),
);

const title = "The drum & bass log, every finding by coordinate · Fluncle";
const description =
  "Every finding in Fluncle's log: one Log ID per track, the date it was found, and the coordinate page that decodes it.";

function logIndexHead(loaderData: LogIndexEntry[] | undefined) {
  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",

    itemListElement: (loaderData ?? []).map((entry, index) => ({
      "@type": "ListItem" as const,
      name: `${entry.logId} · ${artistTitleLine(entry)}`,
      position: index + 1,
      url: `${siteUrl}/log/${encodeURIComponent(entry.logId)}`,
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

    scripts: [jsonLdScript(itemList)],
  };
}

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/log/")({
  loader: () => fetchLog(),
  head: ({ loaderData }: { loaderData?: LogIndexEntry[] }) => logIndexHead(loaderData),
  component: LogIndexPage,
});

function LogIndexPage() {
  const entries = Route.useLoaderData();

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
          <p className="log-index-empty empty-scanlines">
            No findings logged yet. Quiet sector tonight.
          </p>
        ) : (
          <ol className="log-index-list">
            {entries.map((track) => (
              <li className="log-index-row log-index-row--entry" key={track.trackId}>
                <Link className="log-index-id" params={{ logId: track.logId }} to="/log/$logId">
                  {track.logId}
                </Link>
                <Link className="log-index-line" params={{ logId: track.logId }} to="/log/$logId">
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
          <Link to="/findings">Back to the archive</Link>
          <Link to="/about">What a Log ID is</Link>
        </footer>
      </article>
    </main>
  );
}
