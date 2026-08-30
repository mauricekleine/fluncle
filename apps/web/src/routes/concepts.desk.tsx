// ── /concepts/desk — Concept B, the Desk ─────────────────────────────────────
//
// The whole concept is ONE route. There are no sub-pages: a direct arrival on a
// graph node (`?label=Hospital%20Records`, `?artist=Lexurus`) is this same board
// pre-filled and headed by that entity's identity. Every piece of board state
// therefore lives in the search params, which is what makes any state a shareable
// link and the browser's Back button the undo.
//
// Public-style data path: a `createServerFn` the `loader` calls, read back with
// `Route.useLoaderData()`. No react-query — nothing here is a signed-in live
// surface, and every state change is a navigation the server re-renders.
//
// The resolver arrives by a DYNAMIC import inside the handler body and its types
// by `import type`, so this route module never statically references the committed
// snapshot and the fixture stays out of the eager entry chunk
// (docs/client-bundle.md, rule 1; the `-*-page-data.ts` pattern).

import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { Desk } from "@/components/concepts/desk";
import { TEMPO_BANDS, type TempoBandId } from "@/concepts/discovery/model";
import deskCss from "@/concepts/discovery/styles/desk.css?url";
import { type DeskData, type DeskFilters } from "./-concepts-data";

const fetchDesk = createServerFn({ method: "GET" })
  .validator((data: DeskFilters) => data)
  .handler(async ({ data }): Promise<DeskData> => {
    const { resolveDesk } = await import("./-concepts-data");

    return resolveDesk(data);
  });

/**
 * A search value the board can act on. An empty or whitespace-only param drops to
 * `undefined` so `?label=` never renders as an applied facet nobody chose, and a
 * numeric-looking param (the router's parser coerces `q=174` to a number) is read
 * back as the text it was typed as.
 */
function text(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed === "" ? undefined : trimmed;
}

function tempo(value: unknown): TempoBandId | undefined {
  const raw = text(value);

  return TEMPO_BANDS.find((band) => band.id === raw)?.id;
}

function tier(value: unknown): "lit" | undefined {
  return text(value) === "lit" ? "lit" : undefined;
}

// Route options follow TanStack's canonical order (each step feeds the next one's
// inferred types), which is not alphabetical — so sort-keys is off for this call.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/concepts/desk")({
  validateSearch: (search: Record<string, unknown>): DeskFilters => ({
    artist: text(search["artist"]),
    key: text(search["key"]),
    label: text(search["label"]),
    q: text(search["q"]),
    soundsLike: text(search["soundsLike"]),
    tempo: tempo(search["tempo"]),
    tier: tier(search["tier"]),
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }): Promise<DeskData> => fetchDesk({ data: deps }),
  // The parent `/concepts` layout already carries `noindex, nofollow` and the
  // shared sheet; this route adds only its own paint, with `?url` so it never
  // joins the app-wide render-blocking entry stylesheet.
  head: () => ({
    links: [{ href: deskCss, rel: "stylesheet" }],
    meta: [{ title: "Desk · Fluncle" }],
  }),
  component: DeskRoute,
});

function DeskRoute() {
  return <Desk data={Route.useLoaderData()} />;
}
