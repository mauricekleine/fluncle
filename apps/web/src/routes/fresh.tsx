import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { UnlitTracks } from "@/components/graph-sections";
import { GraphLink } from "@/components/graph-link";
import { TrackRow } from "@/components/track-row";
import { siteUrl } from "@/lib/fluncle-links";
import { formatDate } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { logPageUrl } from "@/lib/log-schema";
import { type FreshReleases, type FreshSection, listFreshReleases } from "@/lib/server/fresh";

// `/fresh` — WHAT JUST CAME OUT, across the whole archive.
//
// A reading PLATE that answers one query ("new drum & bass releases") the way a crate digger
// asks it: newest first, the whole frontier, over a trailing 30-day window. It is a HUB, not a
// detail page — always indexable, like /albums or /artists; SEO is the whole point. The findings
// lead each recency section as findings (the Track Row idiom, in full voice), and the uncertified
// rows follow in the unlit register — never named, never given a coordinate (DESIGN.md's Unlit
// Rule). The copy is careful never to claim Fluncle FOUND these: these are RELEASE dates, and the
// two are unrelated (lib/server/fresh.ts; VOICE.md's Found Rule).

// The two recency sections. The label names the WINDOW (true of every row under it — a finding
// and an unlit row alike), never the tier the quieter rows belong to (that tier has no public
// name). A superset heading is what The Unlit Rule expressly permits.
const SECTION_TITLE: Record<FreshSection["key"], string> = {
  earlier: "Earlier this month",
  week: "This week",
};

const fetchFresh = createServerFn({ method: "GET" }).handler(
  (): Promise<FreshReleases> => listFreshReleases(),
);

const title = "New drum & bass releases · Fluncle";
const description =
  "The freshest drum & bass, hot off the press. Every release from the last 30 days, tracked as Fluncle spins his way through them.";

/**
 * The page's JSON-LD: an `ItemList` of the rendered tracks as `MusicRecording`s, bounded to what
 * the page actually shows (the loader is already capped). A finding resolves to its `/log`
 * coordinate; an uncertified row to its off-site URL, or to none — only a finding is ever given a
 * fluncle.com URL, so the structured data never claims a certification that does not exist. The
 * whole payload is HTML-escaped by `jsonLdScript` before it reaches the inline <script> (a
 * `</script>` in a Spotify-sourced title can't break out — the stored-XSS sink).
 */
function freshItemList(data: FreshReleases): Record<string, unknown> {
  type Entry = { artists: string[]; title: string; url?: string };
  const entries: Entry[] = data.sections.flatMap((section) => [
    ...section.findings.flatMap((finding) =>
      finding.logId
        ? [{ artists: finding.artists, title: finding.title, url: logPageUrl(finding.logId) }]
        : [],
    ),
    ...section.catalogue.map((track) => ({
      artists: track.artists,
      title: track.title,
      url: track.spotifyUrl,
    })),
  ]);

  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: entries.map((entry, index) => ({
      "@type": "ListItem",
      item: {
        "@type": "MusicRecording",
        byArtist: entry.artists.map((name) => ({ "@type": "MusicGroup", name })),
        genre: "Drum and Bass",
        name: entry.title,
        ...(entry.url ? { url: entry.url } : {}),
      },
      position: index + 1,
    })),
    name: "New drum & bass releases",
    url: `${siteUrl}/fresh`,
  };
}

function freshHead(loaderData: FreshReleases | undefined) {
  const pageUrl = `${siteUrl}/fresh`;

  return {
    links: [{ href: pageUrl, rel: "canonical" }],
    meta: [
      { title },
      { content: description, name: "description" },
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: `${siteUrl}/fluncle-cover.png`, property: "og:image" },
      { content: pageUrl, property: "og:url" },
      { content: "summary_large_image", name: "twitter:card" },
      { content: title, name: "twitter:title" },
      { content: description, name: "twitter:description" },
    ],
    scripts: loaderData ? [jsonLdScript(freshItemList(loaderData))] : [],
  };
}

// Route options follow TanStack's create-route-property-order (each step feeds the next's
// inferred types), which isn't alphabetical — so sort-keys is off here.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/fresh")({
  loader: (): Promise<FreshReleases> => fetchFresh(),
  head: ({ loaderData }: { loaderData?: FreshReleases }) => freshHead(loaderData),
  component: FreshPage,
});

function FreshPage() {
  const data = Route.useLoaderData();
  const empty = data.sections.length === 0;

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <p className="log-nameplate">Fluncle's Findings</p>
          <h1 className="log-coordinate log-index-title">Fresh</h1>
          <p className="log-index-intro">
            The freshest bangers in the sector, hot off the press. Everything here dropped in the
            last {data.windowDays} days. Still spinning my way through them.
          </p>
        </header>

        {empty ? (
          <p className="log-index-empty empty-scanlines">
            Nothing new landed in the last {data.windowDays} days. Quiet sector.
          </p>
        ) : (
          data.sections.map((section) => (
            <section
              aria-label={SECTION_TITLE[section.key]}
              className="catalogue-section"
              key={section.key}
            >
              <h2 className="artist-similar-label">{SECTION_TITLE[section.key]}</h2>

              {/* The findings lead, as findings — the Track Row idiom in full voice (coordinate,
                  cover, the instrument readout). An empty half renders nothing. */}
              {section.findings.length > 0 ? (
                <ol className="grid m-0 list-none p-0 [&>li:last-child.track-row]:border-b-0">
                  {section.findings.map((finding, index) => (
                    <TrackRow key={finding.trackId} track={finding} trackNumber={index + 1} />
                  ))}
                </ol>
              ) : undefined}

              {/* The quieter rows: released the same week, but not certified — the unlit register.
                  No heading, no noun, nothing when empty (components/graph-sections.tsx). */}
              <UnlitTracks
                label={`More new tracks, ${SECTION_TITLE[section.key].toLowerCase()}`}
                tracks={section.catalogue}
              />
            </section>
          ))
        )}

        {/* The records half — the album entities a fresh release sits on, newest first. A named
            graph node (an album has a page), so it carries its name as a GraphLink, never the
            unnamed tier. Conditional like every band: nothing renders when nothing dropped. */}
        {data.records.length > 0 ? (
          <section aria-label="Records just out" className="catalogue-section">
            <h2 className="artist-similar-label">Records just out</h2>
            <ul className="fresh-records">
              {data.records.map((record) => (
                <li className="fresh-record" key={record.slug}>
                  <GraphLink kind="album" slug={record.slug}>
                    {record.name}
                  </GraphLink>
                  <span className="fresh-record-meta">
                    {record.artists.length > 0 ? `${record.artists.join(", ")} · ` : ""}
                    {formatDate(record.releaseDate)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : undefined}

        <footer className="log-plate-footer">
          <Link to="/log">The whole log</Link>
          <Link to="/">Back to the archive</Link>
        </footer>
      </article>
    </main>
  );
}
