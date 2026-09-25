import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { siteUrl } from "@/lib/fluncle-links";
import { formatDate } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { formatSector, sectorDateISO } from "@/lib/log-id-shared";
import { logbookPath } from "@/lib/logbook";
import { listLogbookIndexEntries, type LogbookIndexEntry } from "@/lib/server/logbook";

const fetchLogbook = createServerFn({ method: "GET" }).handler(() =>
  listLogbookIndexEntries({ limit: 500 }),
);

const title = "Fluncle's Logbook";
const description =
  "Fluncle's Logbook: one first-person entry per day of the voyage. What the day was like, where the trip went, and how each banger landed, with the findings inlined as photos.";

function logbookIndexHead(entries: LogbookIndexEntry[] | undefined) {
  const blog = {
    "@context": "https://schema.org",
    "@type": "Blog",
    blogPost: (entries ?? []).map((entry) => ({
      "@type": "BlogPosting",
      datePublished: sectorDateISO(entry.sector),
      headline: entry.title,
      url: `${siteUrl}${logbookPath(entry.sector)}`,
    })),
    description,
    name: title,
    url: `${siteUrl}/logbook`,
  };

  return {
    links: [{ href: `${siteUrl}/logbook`, rel: "canonical" }],
    meta: [
      { title },
      { content: description, name: "description" },
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: `${siteUrl}/fluncle-cover.png`, property: "og:image" },
      { content: `${siteUrl}/logbook`, property: "og:url" },
    ],

    scripts: [jsonLdScript(blog)],
  };
}

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/logbook/")({
  loader: () => fetchLogbook(),
  head: ({ loaderData }: { loaderData?: LogbookIndexEntry[] }) => logbookIndexHead(loaderData),
  component: LogbookIndexPage,
});

function LogbookIndexPage() {
  const entries = Route.useLoaderData();

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <p className="log-nameplate">Fluncle's Logbook</p>
          <h1 className="log-coordinate log-index-title">The logbook</h1>
          <p className="log-index-intro">
            At the end of a day out there, I write it up: what it was like, and how each banger
            landed. {entries.length} entries logged so far.
          </p>
        </header>

        {entries.length === 0 ? (
          <p className="log-index-empty empty-scanlines">
            No entries written yet. Quiet sector tonight.
          </p>
        ) : (
          <ol className="log-index-list log-index-list--sectors">
            {entries.map((entry) => (
              <li className="log-index-row log-index-row--entry" key={entry.sector}>
                <Link
                  className="log-index-id"
                  params={{ sector: formatSector(entry.sector) }}
                  to="/logbook/$sector"
                >
                  {formatSector(entry.sector)}
                </Link>
                <Link
                  className="log-index-line"
                  params={{ sector: formatSector(entry.sector) }}
                  to="/logbook/$sector"
                >
                  {entry.title}
                </Link>
                <time className="log-index-date" dateTime={sectorDateISO(entry.sector)}>
                  {formatDate(sectorDateISO(entry.sector))}
                </time>
              </li>
            ))}
          </ol>
        )}

        <footer className="log-plate-footer">
          <Link to="/findings">Back to the archive</Link>
          <Link to="/log">The finding log</Link>
        </footer>
      </article>
    </main>
  );
}
