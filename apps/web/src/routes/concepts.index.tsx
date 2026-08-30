import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { type ConceptExhibit } from "./-concepts-data";

// The exhibit index. This page is the FRAME around the three pictures, not one of
// them: it names what each concept is for and records where the data came from,
// so nobody has to infer either from the surfaces. The concepts themselves carry
// no explanation of their own.

const fetchExhibit = createServerFn({ method: "GET" }).handler(
  async (): Promise<ConceptExhibit> => {
    const { resolveExhibit } = await import("./-concepts-data");

    return resolveExhibit();
  },
);

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/concepts/")({
  component: ConceptsIndex,
  loader: () => fetchExhibit(),
  head: () => ({ meta: [{ title: "Discovery concepts · Fluncle" }] }),
});

const CONCEPTS = [
  {
    ia: "One dated page, then a page per record and a page per graph node. Depth is a click.",
    interaction: "Navigation only. No controls, no client state.",
    model: "Fluncle places, you read. Discovery is editorial placement.",
    name: "Front page",
    to: "/concepts/front",
  },
  {
    ia: "One persistent board. A direct arrival on an artist or label is that board, pre-filled.",
    interaction: "Facets, chips, and a sonic seed. Every state is in the URL.",
    model: "You ask, the archive answers. Discovery is filtering.",
    name: "Desk",
    to: "/concepts/desk",
  },
  {
    ia: "One stop at a time, a trail behind it and branches ahead. No lists anywhere.",
    interaction: "Transport: keys and branch controls move you. Motion carries the change.",
    model: "You travel. Discovery is a sequence with branches.",
    name: "Run",
    to: "/concepts/run",
  },
] as const;

function ConceptsIndex() {
  const { capture, entities } = Route.useLoaderData();

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="concept-display text-3xl font-extrabold text-foreground">
        Three discovery concepts
      </h1>
      <p className="mt-3 max-w-[70ch] text-[0.95rem] leading-relaxed text-muted-foreground">
        Three structurally different answers to the same question: how a stranger who lands on
        Fluncle finds drum &amp; bass worth hearing. They share one snapshot of real archive data,
        so what differs between them is the model and never the records. Held for a direction call;
        none of them is proposed.
      </p>

      <ul className="mt-8 grid gap-4">
        {CONCEPTS.map((concept) => (
          <li className="concept-plate p-5" key={concept.to}>
            <h2 className="text-[1.15rem] font-extrabold text-foreground">
              <Link
                className="concept-focus text-inherit no-underline transition-colors duration-150 hover:text-accent-foreground"
                to={concept.to}
              >
                {concept.name}
              </Link>
            </h2>
            <dl className="mt-3 grid gap-2 text-[0.88rem]">
              <div className="flex flex-wrap gap-x-2">
                <dt className="w-28 shrink-0 font-bold text-muted-foreground">Product</dt>
                <dd className="min-w-0 flex-1 text-foreground">{concept.model}</dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="w-28 shrink-0 font-bold text-muted-foreground">Structure</dt>
                <dd className="min-w-0 flex-1 text-foreground">{concept.ia}</dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="w-28 shrink-0 font-bold text-muted-foreground">Interaction</dt>
                <dd className="min-w-0 flex-1 text-foreground">{concept.interaction}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>

      <section aria-labelledby="exhibit-data" className="mt-10">
        <h2 className="text-[1.05rem] font-extrabold text-foreground" id="exhibit-data">
          The data
        </h2>
        <p className="mt-2 max-w-[70ch] text-[0.88rem] leading-relaxed text-muted-foreground">
          Every record, count, cover, and listening link on these three surfaces comes from one
          capture of Fluncle&rsquo;s own public API, taken with{" "}
          <code className="rounded-sm bg-secondary px-1 py-0.5 text-[0.82rem]">
            bun run --cwd apps/web concepts:capture
          </code>
          . Nothing here is generated or filled in.
        </p>
        <dl className="mt-3 grid gap-1 text-[0.85rem] tabular-nums">
          <div className="flex gap-2">
            <dt className="w-40 shrink-0 text-muted-foreground">Captured</dt>
            <dd className="text-foreground">{capture.capturedAt}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-40 shrink-0 text-muted-foreground">Source</dt>
            <dd className="text-foreground">{capture.source}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-40 shrink-0 text-muted-foreground">Live build</dt>
            <dd className="break-all text-foreground">{capture.productionSha}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-40 shrink-0 text-muted-foreground">Rows</dt>
            <dd className="text-foreground">
              {capture.findingCount} recommended, {capture.catalogueRows} more from the archive,{" "}
              {entities.length} artist and label pages
            </dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
