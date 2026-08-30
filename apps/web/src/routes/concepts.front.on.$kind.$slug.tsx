import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { CloseInSound, FrontEntry, FrontRelease } from "@/components/concepts/front";
import { Cover } from "@/components/concepts/shared";
import frontCss from "@/concepts/discovery/styles/front.css?url";
import { type ConceptEntityKind, trackKey } from "@/concepts/discovery/model";
import { type FrontEntityData } from "./-concepts-data";

// Concept A's entity landing: a dossier, in the catalogue register. The page
// states what the thing is, plainly; Fluncle appears as data and never as
// narrator (DESIGN.md / VOICE.md, The Three Areas Rule).
//
// Structure is the whole argument here too. Findings lead under a heading that
// names them. What Fluncle holds but has not certified follows in a block with NO
// heading at all — a homogeneous unlit block is never introduced as a tier,
// because it is not one the reader is asked to learn (The Unlit Rule).

const KINDS: ConceptEntityKind[] = ["album", "artist", "label"];

function parseKind(raw: string): ConceptEntityKind | undefined {
  return KINDS.find((kind) => kind === raw);
}

const fetchEntity = createServerFn({ method: "GET" })
  .validator((data: { kind: ConceptEntityKind; slug: string }) => data)
  .handler(async ({ data: { kind, slug } }): Promise<FrontEntityData> => {
    const { resolveFrontEntity } = await import("./-concepts-data");

    return resolveFrontEntity(kind, slug);
  });

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/concepts/front/on/$kind/$slug")({
  component: FrontEntityPage,
  loader: ({ params }) => {
    const kind = parseKind(params.kind);

    if (kind === undefined) {
      throw notFound();
    }

    return fetchEntity({ data: { kind, slug: params.slug } });
  },
  head: ({ loaderData }) => ({
    links: [{ href: frontCss, rel: "stylesheet" }],
    meta: [
      {
        title:
          loaderData?.status === "found"
            ? `${loaderData.page.entity.name} · discovery concept · Fluncle`
            : "Not in the archive · discovery concept · Fluncle",
      },
    ],
  }),
});

function FrontEntityPage() {
  const data = Route.useLoaderData();

  if (data.status === "missing") {
    return (
      <main className="front-page concept-plate">
        <h1 className="front-masthead-title concept-display">Nothing under that name.</h1>
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

  const { catalogue, entity, findings, neighbourhood } = data.page;

  return (
    <main className="front-page concept-plate">
      <header className="front-dossier">
        <div className="flex flex-col gap-4">
          <h1 className="front-masthead-title concept-display">{entity.name}</h1>
          {entity.bio === undefined ? null : (
            <p className="max-w-[68ch] text-[0.95rem] leading-relaxed text-foreground">
              {entity.bio}
            </p>
          )}
          <p className="text-[0.85rem] text-muted-foreground tabular-nums">
            {entity.findingCount} recommended by Fluncle
          </p>
        </div>
        {entity.imageUrl === undefined ? null : (
          <Cover
            className="front-entity-portrait"
            lit={entity.certified}
            priority
            src={entity.imageUrl}
          />
        )}
      </header>

      {findings.length === 0 ? null : (
        <section aria-labelledby="entity-findings" className="mt-8">
          <h2 className="text-[1.05rem] font-extrabold text-foreground" id="entity-findings">
            Recommended by Fluncle
          </h2>
          <div className="front-column">
            {findings.map((track, index) => (
              <FrontEntry key={trackKey(track, index)} track={track} />
            ))}
          </div>
        </section>
      )}

      {catalogue.length === 0 ? null : (
        <section className="front-band">
          <div>
            {catalogue.map((track, index) => (
              <FrontRelease key={trackKey(track, index)} track={track} />
            ))}
          </div>
        </section>
      )}

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
