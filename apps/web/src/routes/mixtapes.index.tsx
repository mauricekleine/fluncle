import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { siteUrl } from "@/lib/fluncle-links";
import { formatAlbumDuration } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { type MixtapeDTO, mixtapeCoverUrl, mixtapeDisplayTitle } from "@/lib/mixtapes";
import { listMixtapes } from "@/lib/server/mixtapes";

const fetchMixtapes = createServerFn({ method: "GET" }).handler(() => listMixtapes());

const title = "Fluncle: mixtapes";
const description = "Fluncle's own DJ mixtapes, checkpoints he mixes from his findings.";

// oxlint-disable-next-line sort-keys -- TanStack canonical property order (loader before head); see AGENTS.md
export const Route = createFileRoute("/mixtapes/")({
  component: MixtapesPage,
  loader: () => fetchMixtapes(),
  head: ({ loaderData }: { loaderData?: MixtapeDTO[] }) => ({
    links: [
      { href: `${siteUrl}/mixtapes`, rel: "canonical" },
      // oEmbed discovery: a pasted /mixtapes link unfurls as a `link`-type card
      // (title + Fluncle cover). See routes/oembed.ts.
      {
        href: `${siteUrl}/oembed?url=${encodeURIComponent(`${siteUrl}/mixtapes`)}&format=json`,
        rel: "alternate",
        title,
        type: "application/json+oembed",
      },
    ],
    meta: [
      { title },
      { content: description, name: "description" },
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: `${siteUrl}/fluncle-cover.png`, property: "og:image" },
      { content: `${siteUrl}/mixtapes`, property: "og:url" },
    ],
    // JSON-LD goes through `jsonLdScript`, which HTML-escapes the serialized
    // payload before it reaches the inline <script>'s `children` (rendered raw
    // via dangerouslySetInnerHTML), so a `</script>` in a mixtape title can't
    // break out of the <script> (stored-XSS sink, security review).
    scripts: [
      jsonLdScript({
        "@context": "https://schema.org",
        "@type": "ItemList",
        itemListElement: loaderData?.map((mixtape, index) => ({
          "@type": "ListItem",
          name: `${mixtape.logId} · ${mixtape.title}`,
          position: index + 1,
          url: `${siteUrl}/log/${encodeURIComponent(mixtape.logId as string)}`,
        })),
        name: "Fluncle's mixtapes",
        url: `${siteUrl}/mixtapes`,
      }),
    ],
  }),
});

function MixtapesPage() {
  const mixtapes = Route.useLoaderData();

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <p className="log-nameplate">Fluncle's Findings</p>
          <h1 className="log-coordinate log-index-title">Mixtapes</h1>
          <p className="log-index-intro">
            Checkpoints from the archive: I mix the findings into one long dream.
          </p>
        </header>

        {mixtapes.length === 0 ? (
          <p className="log-index-empty empty-scanlines">
            No mixtapes logged yet. Quiet deck tonight.
          </p>
        ) : (
          <ol className="log-index-list">
            {mixtapes.map((mixtape) => (
              <li className="log-index-row" key={mixtape.logId}>
                <Link
                  aria-hidden="true"
                  className="log-index-cover-link"
                  params={{ logId: mixtape.logId as string }}
                  tabIndex={-1}
                  to="/log/$logId"
                >
                  <img
                    alt=""
                    className="log-index-cover"
                    height={160}
                    loading="lazy"
                    src={mixtapeCoverUrl(mixtape.logId as string, "thumb")}
                    width={160}
                  />
                </Link>
                <div className="log-index-body">
                  <Link
                    className="log-index-id"
                    params={{ logId: mixtape.logId as string }}
                    to="/log/$logId"
                  >
                    {mixtape.logId}
                  </Link>
                  <Link
                    className="log-index-line"
                    params={{ logId: mixtape.logId as string }}
                    to="/log/$logId"
                  >
                    {mixtapeDisplayTitle(mixtape.title)}
                  </Link>
                  <span className="log-index-date">
                    {mixtape.memberCount} bangers
                    {mixtape.durationMs ? ` · ${formatAlbumDuration(mixtape.durationMs)}` : ""}
                  </span>
                </div>
              </li>
            ))}
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
