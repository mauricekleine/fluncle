import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { Fragment } from "react";
import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { siteUrl } from "@/lib/fluncle-links";
import { formatDateLong } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { formatSector, parseSectorParam, sectorDateISO } from "@/lib/log-id-shared";
import {
  type LogbookBlock,
  type LogbookFigureFinding,
  type LogbookInline,
  logbookPath,
  parseLogbookBody,
  resolveLogbookFigure,
} from "@/lib/logbook";
import {
  getLogbookEntry,
  getLogbookNeighbors,
  getSectorFindings,
  type LogbookNeighbor,
} from "@/lib/server/logbook";
import { type LogbookEntryDTO } from "@fluncle/contracts";

// One Logbook entry — a first-person travelogue for a single sector-day, at
// /logbook/<sector> (e.g. /logbook/036). Long-form AEO fuel: server-rendered, clean
// heading structure, the day's findings inlined as real "photos" (their posters),
// and an Article JSON-LD block that mirrors the visible prose. The quiet archival
// plate register, shared with /log.

type LogbookPageData =
  | {
      status: "found";
      entry: LogbookEntryDTO;
      // The day's findings, keyed by Log ID — the figure-caption source.
      findings: Record<string, LogbookFigureFinding>;
      newer?: LogbookNeighbor;
      older?: LogbookNeighbor;
    }
  | { status: "missing" };

const fetchLogbookEntry = createServerFn({ method: "GET" })
  .validator((data: { sector: number }) => data)
  .handler(async ({ data: { sector } }): Promise<LogbookPageData> => {
    const entry = await getLogbookEntry(sector);

    if (!entry) {
      return { status: "missing" };
    }

    const [findings, neighbors] = await Promise.all([
      getSectorFindings(sector),
      getLogbookNeighbors(sector),
    ]);

    return { ...neighbors, entry, findings, status: "found" };
  });

// A typed head() outside the route options (reading loaderData inline makes the
// route's own inference circular — the /log precedent).
function logbookHead(loaderData: LogbookPageData | undefined) {
  if (loaderData?.status !== "found") {
    return {};
  }

  const { entry } = loaderData;
  const sectorLabel = formatSector(entry.sector);
  const pageUrl = `${siteUrl}${logbookPath(entry.sector)}`;
  const title = `Sector ${sectorLabel} · Fluncle's Logbook`;
  const datePublished = sectorDateISO(entry.sector);
  // A short, honest description: the entry title, the human dateline.
  const description = `${entry.title} — Fluncle's log for sector ${sectorLabel}, ${formatDateLong(datePublished)}.`;

  // An Article that mirrors the visible entry (headline = title, the coordinate URL,
  // the sector-day as datePublished, the last (re)generation as dateModified, Fluncle
  // as the author). Honest structured data, not invented.
  const article = {
    "@context": "https://schema.org",
    "@type": "Article",
    author: { "@type": "Person", name: "Fluncle", url: `${siteUrl}/about` },
    dateModified: entry.generatedAt,
    datePublished,
    description,
    headline: entry.title,
    inLanguage: "en",
    isPartOf: { "@type": "Blog", name: "Fluncle's Logbook", url: `${siteUrl}/logbook` },
    mainEntityOfPage: pageUrl,
    publisher: { "@type": "Organization", name: "Fluncle", url: siteUrl },
    url: pageUrl,
  };

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
      { content: datePublished, property: "article:published_time" },
      { content: entry.generatedAt, property: "article:modified_time" },
      { content: "summary_large_image", name: "twitter:card" },
      { content: title, name: "twitter:title" },
      { content: description, name: "twitter:description" },
    ],
    // JSON-LD goes through `jsonLdScript`, which HTML-escapes the serialized payload
    // before it reaches the inline <script> (rendered raw via dangerouslySetInnerHTML),
    // so a `</script>` in the (agent-authored) title/body can't break out.
    scripts: [jsonLdScript(article)],
  };
}

// Route options follow TanStack's create-route-property-order (each step feeds the
// next's inferred types), which isn't alphabetical — so sort-keys is off here.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/logbook/$sector")({
  // Shape-guard BEFORE the loader: a non-sector param is a 404, no DB roundtrip.
  beforeLoad: ({ params }) => {
    if (parseSectorParam(params.sector) === null) {
      throw notFound();
    }
  },
  loader: async ({ params }): Promise<LogbookPageData> => {
    const sector = parseSectorParam(params.sector);

    if (sector === null) {
      throw notFound();
    }

    const data = await fetchLogbookEntry({ data: { sector } });

    if (data.status === "missing") {
      throw notFound();
    }

    return data;
  },
  head: ({ loaderData }: { loaderData?: LogbookPageData }) => logbookHead(loaderData),
  component: LogbookEntryPage,
  notFoundComponent: StoryNotFoundState,
});

function InlineRun({ segments }: { segments: LogbookInline[] }) {
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.type === "strong") {
          return <strong key={index}>{segment.text}</strong>;
        }

        if (segment.type === "em") {
          return <em key={index}>{segment.text}</em>;
        }

        return <Fragment key={index}>{segment.text}</Fragment>;
      })}
    </>
  );
}

function LogbookBody({
  blocks,
  findings,
}: {
  blocks: LogbookBlock[];
  findings: Record<string, LogbookFigureFinding>;
}) {
  return (
    <div className="logbook-prose">
      {blocks.map((block, index) => {
        if (block.type === "figure") {
          const figure = resolveLogbookFigure(block.logId, findings);

          return (
            <figure className="logbook-photo" key={`${block.logId}-${index}`}>
              <Link params={{ logId: figure.logId }} to="/log/$logId">
                <img alt={figure.caption} loading="lazy" src={figure.posterUrl} />
              </Link>
              <figcaption>
                <Link params={{ logId: figure.logId }} to="/log/$logId">
                  {figure.caption}
                </Link>
              </figcaption>
            </figure>
          );
        }

        if (block.type === "heading") {
          return block.level === 3 ? (
            <h3 key={index}>
              <InlineRun segments={block.content} />
            </h3>
          ) : (
            <h2 key={index}>
              <InlineRun segments={block.content} />
            </h2>
          );
        }

        return (
          <p key={index}>
            <InlineRun segments={block.content} />
          </p>
        );
      })}
    </div>
  );
}

function NeighborLink({
  direction,
  neighbor,
}: {
  direction: "newer" | "older";
  neighbor: LogbookNeighbor;
}) {
  const isOlder = direction === "older";

  return (
    <Link
      className={isOlder ? "log-neighbor log-neighbor-older" : "log-neighbor"}
      params={{ sector: formatSector(neighbor.sector) }}
      to="/logbook/$sector"
    >
      {isOlder ? undefined : <CaretLeftIcon aria-hidden="true" weight="bold" />}
      <span>
        <span className="log-neighbor-label">{isOlder ? "Earlier" : "Later"}</span>
        <span className="log-neighbor-line">Sector {formatSector(neighbor.sector)}</span>
      </span>
      {isOlder ? <CaretRightIcon aria-hidden="true" weight="bold" /> : undefined}
    </Link>
  );
}

function LogbookEntryPage() {
  const data = Route.useLoaderData();

  if (data.status !== "found") {
    return null;
  }

  const { entry, findings, newer, older } = data;
  const sectorLabel = formatSector(entry.sector);
  const datePublished = sectorDateISO(entry.sector);
  const blocks = parseLogbookBody(entry.body);

  return (
    <main className="log-plate-stage">
      <article className="log-plate logbook-entry">
        <header className="log-masthead">
          <p className="log-nameplate">Fluncle's Logbook</p>
          <h1 className="log-coordinate">Sector {sectorLabel}</h1>
          <p className="logbook-dateline">
            <time dateTime={datePublished}>{formatDateLong(datePublished)}</time>
          </p>
        </header>

        <p className="logbook-title">{entry.title}</p>

        <LogbookBody blocks={blocks} findings={findings} />

        <nav aria-label="Adjacent logbook entries" className="log-neighbors">
          {newer ? <NeighborLink direction="newer" neighbor={newer} /> : <span />}
          {older ? <NeighborLink direction="older" neighbor={older} /> : <span />}
        </nav>

        <footer className="log-plate-footer">
          <Link to="/logbook">The whole logbook</Link>
          <Link to="/">Back to the archive</Link>
        </footer>
      </article>
    </main>
  );
}
