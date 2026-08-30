import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { CloseInSound, FrontEntry, TrackImprint } from "@/components/concepts/front";
import { Coordinate, Cover, ListenRow, Readout } from "@/components/concepts/shared";
import frontCss from "@/concepts/discovery/styles/front.css?url";
import { billing, trackKey } from "@/concepts/discovery/model";
import { type FrontFindingData } from "./-concepts-data";

// Concept A's second level: the record's own page. Editorially the same object as
// the lead, given a whole surface — and the one place the sonic step out is
// offered, as an edited block rather than a control the reader has to operate.

const fetchFinding = createServerFn({ method: "GET" })
  .validator((data: { logId: string }) => data)
  .handler(async ({ data: { logId } }): Promise<FrontFindingData> => {
    const { resolveFrontFinding } = await import("./-concepts-data");

    return resolveFrontFinding(logId);
  });

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/concepts/front/track/$logId")({
  component: FrontTrackPage,
  loader: ({ params }) => fetchFinding({ data: { logId: params.logId } }),
  head: ({ loaderData }) => ({
    links: [{ href: frontCss, rel: "stylesheet" }],
    meta: [
      {
        title:
          loaderData?.status === "found"
            ? `${billing(loaderData.finding)} · discovery concept · Fluncle`
            : "Not in the archive · discovery concept · Fluncle",
      },
    ],
  }),
});

function FrontTrackPage() {
  const data = Route.useLoaderData();

  if (data.status === "missing") {
    return (
      <main className="front-page concept-plate">
        <h1 className="front-masthead-title concept-display">Nothing at this coordinate.</h1>
        <p className="mt-3 text-[0.9rem] text-muted-foreground">
          I went looking and came up empty.
        </p>
        <Link
          className="concept-focus mt-4 inline-block text-[0.85rem] font-bold text-muted-foreground transition-colors duration-150 hover:text-accent-foreground"
          to="/concepts/front"
        >
          Back to the front page
        </Link>
      </main>
    );
  }

  const { finding, neighbourhood, sameLabel } = data;

  return (
    <main className="front-page concept-plate">
      <div className="front-dossier">
        <article>
          <div className="front-lead">
            <div className="front-lead-frame">
              <Cover
                className="front-lead-cover"
                lit={finding.certified}
                priority
                src={finding.coverUrl}
              />
            </div>
            <div className="flex flex-col items-start gap-4">
              <Coordinate track={finding} />
              <h1 className="front-lead-title">{billing(finding)}</h1>
              {finding.note === undefined ? null : <p className="front-note">{finding.note}</p>}
              <Readout track={finding} />
              <TrackImprint track={finding} />
              <ListenRow size="lg" track={finding} />
            </div>
          </div>
        </article>

        {sameLabel.length === 0 ? null : (
          <aside aria-labelledby="front-imprint" className="front-sidebar">
            <h2 className="text-[1.02rem] font-extrabold text-foreground" id="front-imprint">
              More from {finding.label}
            </h2>
            <div>
              {sameLabel.map((track, index) => (
                <FrontEntry key={trackKey(track, index)} track={track} />
              ))}
            </div>
          </aside>
        )}
      </div>

      {neighbourhood === undefined ? null : (
        <CloseInSound anchor={neighbourhood.anchor} tracks={neighbourhood.neighbours} />
      )}

      <Link
        className="concept-focus mt-8 inline-block text-[0.85rem] font-bold text-muted-foreground transition-colors duration-150 hover:text-accent-foreground"
        to="/concepts/front"
      >
        Back to the front page
      </Link>
    </main>
  );
}
