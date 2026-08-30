import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { type RunSearch } from "@/components/concepts/run-link";
import { Run } from "@/components/concepts/run";
import runCss from "@/concepts/discovery/styles/run.css?url";

import { type RunData, type RunStop } from "./-concepts-data";

// ── /concepts/run — Concept C, the Run ────────────────────────────────────────
//
// A player-shaped discovery surface: one track at a time, always a next one, and
// the branches out of it shown with the actual track each one leads to. The
// component owns the shape; this file owns the URL and the read.
//
// The resolver arrives by a DYNAMIC import inside the handler and its types by
// `import type`, so the committed snapshot never reaches the eager entry chunk
// (docs/client-bundle.md, rule 1 — the `-*-page-data.ts` pattern). The stylesheet
// arrives through `head` with `?url` for the same reason on the CSS side (rule 2).
//
// Public-style read: loader plus `useLoaderData`, no react-query. Nothing here is
// live and nothing here is signed in.

const fetchRun = createServerFn({ method: "GET" })
  .validator((data: RunStop) => data)
  .handler(async ({ data }): Promise<RunData> => {
    const { resolveRun } = await import("./-concepts-data");

    return resolveRun(data);
  });

function textParam(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A step is an index into the lane. Anything that is not one reads as the first. */
function stepParam(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : value;

  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return Math.floor(parsed);
}

// Route options follow TanStack's create-route-property-order (each step feeds the
// next's inferred types), which isn't alphabetical — so sort-keys is off here.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/concepts/run")({
  validateSearch: (search: Record<string, unknown>): RunSearch => ({
    anchor: textParam(search["anchor"]),
    entity: textParam(search["entity"]),
    step: stepParam(search["step"]),
  }),
  // The default lands HERE, so the resolver always gets a real step while the URL
  // keeps it implicit: a bare `/concepts/run` is the first stop of the lane, and
  // `resolveRun` clamps anything past the end back onto the last one.
  loaderDeps: ({ search }) => ({
    anchor: search.anchor,
    entity: search.entity,
    step: search.step ?? 0,
  }),
  loader: ({ deps }): Promise<RunData> => fetchRun({ data: deps }),
  head: () => ({ links: [{ href: runCss, rel: "stylesheet" }] }),
  component: RunConcept,
});

function RunConcept() {
  return <Run data={Route.useLoaderData()} />;
}
