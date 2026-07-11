import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type EditionDTO, editionFindingCount, editionIntroSnippet } from "@/lib/editions";
import { siteUrl } from "@/lib/fluncle-links";
import { formatDateLong } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { listEditions } from "@/lib/server/editions";

// The public newsletter archive (`/newsletter`): every back issue of the
// mothership, each a readable web page rather than a dead email. The list is the
// sent editions, newest first — the same structured payload the email renders
// from, shown here as the archival register (the log-plate family).

const fetchEditions = createServerFn({ method: "GET" }).handler(() => listEditions());

const title = "Fluncle: the mothership";
const description =
  "Every back issue of the mothership. Fresh bangers, every Friday, from Fluncle.";

// oxlint-disable-next-line sort-keys -- TanStack canonical property order (loader before head); see AGENTS.md
export const Route = createFileRoute("/newsletter/")({
  component: NewsletterArchivePage,
  loader: () => fetchEditions(),
  head: ({ loaderData }: { loaderData?: EditionDTO[] }) => ({
    links: [{ href: `${siteUrl}/newsletter`, rel: "canonical" }],
    meta: [
      { title },
      { content: description, name: "description" },
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: `${siteUrl}/fluncle-cover.png`, property: "og:image" },
      { content: `${siteUrl}/newsletter`, property: "og:url" },
    ],
    // JSON-LD through `jsonLdScript`, which HTML-escapes the serialized payload
    // before the inline <script>, so a subject with `</script>` can't break out
    // (the same stored-XSS guard the mixtape index uses).
    scripts: [
      jsonLdScript({
        "@context": "https://schema.org",
        "@type": "ItemList",
        itemListElement: loaderData
          ?.filter((edition) => edition.number !== undefined)
          .map((edition, index) => ({
            "@type": "ListItem",
            name: edition.subject ?? `Edition #${edition.number}`,
            position: index + 1,
            url: `${siteUrl}/newsletter/${edition.number}`,
          })),
        name: "The mothership: Fluncle's back issues",
        url: `${siteUrl}/newsletter`,
      }),
    ],
  }),
});

function NewsletterArchivePage() {
  const editions = Route.useLoaderData();

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <p className="log-nameplate">The mothership</p>
          <h1 className="log-coordinate log-index-title">Back issues</h1>
          <p className="log-index-intro">
            Fresh bangers, every Friday, from Fluncle. Every letter I send the crew, kept here for
            the ones who missed a departure.
          </p>
        </header>

        {editions.length === 0 ? (
          <p className="log-index-empty empty-scanlines">
            The mothership hasn't departed yet. First letter goes out a Friday soon.
          </p>
        ) : (
          <ol className="log-index-list">
            {editions.map((edition) => {
              const snippet = editionIntroSnippet(edition.content);
              const count = editionFindingCount(edition.content);

              return (
                <li
                  className="log-index-row log-index-row--entry log-index-row--edition"
                  key={edition.id}
                >
                  <Link
                    className="log-index-id"
                    params={{ number: String(edition.number) }}
                    to="/newsletter/$number"
                  >
                    #{edition.number}
                  </Link>
                  <Link
                    className="log-index-line"
                    params={{ number: String(edition.number) }}
                    to="/newsletter/$number"
                  >
                    {edition.subject ?? `Edition #${edition.number}`}
                  </Link>
                  <span className="log-index-date">
                    {edition.sentAt ? formatDateLong(edition.sentAt) : null}
                  </span>
                  {snippet ? (
                    <p className="log-newsletter-snippet">{snippet}</p>
                  ) : count > 0 ? (
                    <p className="log-newsletter-snippet">
                      {count} {count === 1 ? "finding" : "findings"} logged.
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}

        <footer className="log-plate-footer">
          <Link to="/">Back to the archive</Link>
          <Link to="/log">The full log</Link>
        </footer>
      </article>
    </main>
  );
}
