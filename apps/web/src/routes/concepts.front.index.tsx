import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import {
  FrontEntry,
  FrontLead,
  FrontRecord,
  FrontRelease,
  FrontTile,
} from "@/components/concepts/front";
import frontCss from "@/concepts/discovery/styles/front.css?url";
import { trackKey } from "@/concepts/discovery/model";
import { type FrontPageData } from "./-concepts-data";

// ── Concept A: the front page ────────────────────────────────────────────────
//
// The model is EDITORIAL. Fluncle places; the visitor reads. There is no control
// on this page and no state to hold: the lead gets the room, the column carries
// the rest of what he has recommended lately, and the band under them carries
// what came out — a different KIND of block, on its own ground, so the eye reads
// the change before it reads a word (DESIGN.md, The Unlit Rule).
//
// Its answer to "where do I go next" is a link, always. That is the whole
// argument, and the tradeoff sheet in docs/concepts/discovery/README.md says what
// it costs.

const fetchFrontPage = createServerFn({ method: "GET" }).handler(
  async (): Promise<FrontPageData> => {
    const { resolveFrontPage } = await import("./-concepts-data");

    return resolveFrontPage();
  },
);

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/concepts/front/")({
  component: FrontPage,
  loader: () => fetchFrontPage(),
  head: () => ({
    links: [{ href: frontCss, rel: "stylesheet" }],
    meta: [{ title: "Drum & bass bangers · Fluncle" }],
  }),
});

/** The graph nodes the snapshot holds a dossier for. */
const ENTITY_LINKS = [
  { kind: "artist", label: "Lexurus", slug: "lexurus" },
  { kind: "label", label: "Hospital Records", slug: "hospital-records" },
  { kind: "label", label: "V Recordings", slug: "v-recordings" },
] as const;

function FrontPage() {
  const { archive, column, lead, records, releaseWindowDays, releases } = Route.useLoaderData();

  return (
    <main className="front-page concept-plate">
      <header className="front-masthead">
        <h1 className="front-masthead-title concept-display">Drum &amp; bass bangers</h1>
        <p className="text-[0.9rem] text-muted-foreground">
          The tracks Fluncle found and certified, the labels behind them, and the drum &amp; bass
          out lately.
        </p>
      </header>

      <FrontLead track={lead} />

      <section aria-labelledby="front-recent">
        <h2 className="text-[1.05rem] font-extrabold text-foreground" id="front-recent">
          Recommended by Fluncle
        </h2>
        <div className="front-column">
          {column.map((track, index) => (
            <FrontEntry key={trackKey(track, index)} track={track} />
          ))}
        </div>
      </section>

      <section aria-labelledby="front-releases" className="front-band">
        <h2 className="text-[1.05rem] font-extrabold text-foreground" id="front-releases">
          Out lately
        </h2>
        <p className="mt-1 mb-4 text-[0.85rem] text-muted-foreground">
          Drum &amp; bass released in the last {releaseWindowDays} days.
        </p>
        <div className="mt-3">
          {records.map((record) => (
            <FrontRecord key={record.slug} record={record} />
          ))}
          {releases.map((track, index) => (
            <FrontRelease key={trackKey(track, index)} track={track} />
          ))}
        </div>
      </section>

      <section aria-labelledby="front-earlier">
        <h2 className="mt-10 text-[1.05rem] font-extrabold text-foreground" id="front-earlier">
          Earlier
        </h2>
        <div className="front-archive">
          {archive.map((track, index) => (
            <FrontTile key={trackKey(track, index)} track={track} />
          ))}
        </div>
      </section>

      <nav aria-label="Artists and labels" className="mt-10 flex flex-wrap gap-x-4 gap-y-2">
        {ENTITY_LINKS.map((entity) => (
          <Link
            className="concept-focus text-[0.85rem] text-muted-foreground underline decoration-dotted underline-offset-4 transition-colors duration-150 hover:text-accent-foreground hover:decoration-solid"
            key={entity.slug}
            params={{ kind: entity.kind, slug: entity.slug }}
            to="/concepts/front/on/$kind/$slug"
          >
            {entity.label}
          </Link>
        ))}
      </nav>
    </main>
  );
}
