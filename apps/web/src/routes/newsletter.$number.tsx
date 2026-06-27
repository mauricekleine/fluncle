import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type EditionDTO, orderedGalaxies } from "@/lib/editions";
import { logPageUrl, siteUrl } from "@/lib/fluncle-links";
import { formatDateLong } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { getEditionByNumber } from "@/lib/server/editions";

// One back issue of the mothership (`/newsletter/<number>`) rendered as a proper
// web page — the intro, the galaxy-grouped finds (each linking to its permanent
// /log page), the mixtape, the tidbits — NOT the embedded email HTML. The same
// stored `content` payload the email renders from; one source, two renders.

const fetchEdition = createServerFn({ method: "GET" })
  .validator((data: { number: string }) => data)
  .handler(async ({ data: { number } }): Promise<EditionDTO> => {
    const parsed = Number.parseInt(number, 10);

    if (!Number.isInteger(parsed) || parsed < 1) {
      throw notFound();
    }

    const edition = await getEditionByNumber(parsed);

    if (!edition) {
      throw notFound();
    }

    return edition;
  });

// A typed head() outside the route options — reading loaderData inline makes the
// route's own type inference circular (the same pattern the log page uses).
function editionHead(edition: EditionDTO | undefined) {
  if (!edition) {
    return {};
  }

  const pageUrl = `${siteUrl}/newsletter/${edition.number}`;
  const title = `#${edition.number} · ${edition.subject ?? "The mothership"} · Fluncle`;
  const description =
    edition.content.intro?.trim() ?? "A back issue of the mothership: fresh bangers from Fluncle.";

  return {
    links: [{ href: pageUrl, rel: "canonical" }],
    meta: [
      { title },
      { content: description, name: "description" },
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: `${siteUrl}/fluncle-cover.png`, property: "og:image" },
      { content: pageUrl, property: "og:url" },
      { content: "article", property: "og:type" },
    ],
    scripts: [
      jsonLdScript({
        "@context": "https://schema.org",
        "@type": "Article",
        author: { "@type": "Person", name: "Fluncle" },
        datePublished: edition.sentAt,
        headline: edition.subject ?? `Edition #${edition.number}`,
        url: pageUrl,
      }),
    ],
  };
}

// oxlint-disable-next-line sort-keys -- TanStack canonical property order (loader before head); see AGENTS.md
export const Route = createFileRoute("/newsletter/$number")({
  component: EditionPage,
  loader: ({ params }) => fetchEdition({ data: { number: params.number } }),
  head: ({ loaderData }: { loaderData?: EditionDTO }) => editionHead(loaderData),
  notFoundComponent: EditionNotFound,
});

function EditionPage() {
  const edition = Route.useLoaderData();
  const { content } = edition;
  const galaxies = orderedGalaxies(content);

  return (
    <main className="log-plate-stage">
      <article className="log-plate">
        <header className="log-masthead">
          <p className="log-nameplate">The mothership · #{edition.number}</p>
          <h1 className="log-coordinate log-index-title">
            {edition.subject ?? `Edition #${edition.number}`}
          </h1>
          {edition.sentAt ? (
            <p className="log-coordinate-uri">Found {formatDateLong(edition.sentAt)}</p>
          ) : null}
        </header>

        {content.intro?.trim() ? <p className="log-newsletter-intro">{content.intro}</p> : null}

        {galaxies.map((block) => (
          <section className="log-related" key={block.galaxy}>
            {block.galaxy.trim() ? <h2>{block.galaxy}</h2> : null}
            <ul className="log-related-list">
              {block.findings.map((finding) => (
                <li key={finding.logId}>
                  <a href={logPageUrl(finding.logId)}>
                    <span className="log-related-coordinate">{finding.logId}</span>
                    {finding.why?.trim() ? (
                      <span className="log-newsletter-why">{finding.why}</span>
                    ) : null}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ))}

        {content.mixtapeRef?.trim() ? (
          <section className="log-related">
            <h2>And a new mixtape</h2>
            <ul className="log-related-list">
              <li>
                <a href={logPageUrl(content.mixtapeRef)}>
                  <span className="log-related-coordinate">{content.mixtapeRef}</span>
                  <span className="log-related-line">
                    One long dream, made from the week's finds.
                  </span>
                </a>
              </li>
            </ul>
          </section>
        ) : null}

        {content.tidbits?.length ? (
          <section className="log-related">
            <h2>From the wider cosmos</h2>
            <ul className="log-newsletter-tidbits">
              {content.tidbits.map((tidbit, index) => (
                <li key={`${index}-${tidbit.text.slice(0, 24)}`}>
                  {tidbit.text}
                  {tidbit.source?.trim() ? (
                    <>
                      {" "}
                      <a href={tidbit.source} rel="noreferrer" target="_blank">
                        (source)
                      </a>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <p className="log-newsletter-signoff">Happy raving, Fluncle</p>

        <footer className="log-plate-footer">
          <Link to="/newsletter">All back issues</Link>
          <Link to="/log">The full log</Link>
        </footer>
      </article>
    </main>
  );
}

function EditionNotFound() {
  return (
    <main className="log-plate-stage">
      <article className="log-plate">
        <header className="log-masthead">
          <p className="log-nameplate">The mothership</p>
          <h1 className="log-coordinate log-index-title">No such issue</h1>
          <p className="log-index-intro">
            That one never left the launchpad. Try the back issues for the letters that did.
          </p>
        </header>
        <footer className="log-plate-footer">
          <Link to="/newsletter">All back issues</Link>
          <Link to="/">Back to the archive</Link>
        </footer>
      </article>
    </main>
  );
}
