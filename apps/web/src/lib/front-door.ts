// The front door's CLIENT-SAFE shapes and its OWN count formatting.
//
// `-front-door-data.ts` is a server module (it reaches `lib/server/**`, so it can only be reached
// through a dynamic import inside a `createServerFn` handler — docs/client-bundle.md, Rule 1). The
// components that RENDER its payload run in the browser, so the shapes they need live here, where
// both sides can import them without dragging `getDb` and `@libsql/client` into the eager chunk.

/** The four shelves the front door opens onto, with the real size of each. */
export type FrontDoorCounts = {
  albums: number;
  artists: number;
  labels: number;
  tracks: number;
};

/**
 * Thousands separators, for this page and no other.
 *
 * The front door is the one surface that prints a findings total and four shelf counts within a
 * single screen, so at catalogue scale a bare `1234` would sit beside a grouped `1,234` and read as
 * two different numbers. That is a FRONT-DOOR problem, and the fix belongs here rather than in
 * `lib/format.ts`.
 *
 * `lib/format.ts`'s `findingsCount` / `tracksCount` / `bangersCount` are deliberately NOT changed to
 * match. They are shared by surfaces whose bytes are a published contract — `graph-prose.ts` carries
 * `findingsCount` into the `get_graph_preview` op and so into `GET /api/v1/graph/{kind}/{slug}`, and
 * `agent-discovery.ts` carries it into the generated markdown homepage and `llms-full.txt`. Grouping
 * a number there would change a response body that nothing asked to change. Isolation is the point:
 * this module is unreachable from every public response emitter, and `front-door-isolation.test.ts`
 * fails the build if that ever stops being true.
 */
const frontDoorNumber = new Intl.NumberFormat("en-US");

/**
 * "1,234 albums" — a shelf's real size in its superset noun, grouped for this page.
 *
 * Pluralization is arithmetic rather than a per-caller decision, the same rule `lib/format.ts`
 * applies to its own counts; this one just groups the digits too.
 */
export function frontDoorCount(count: number, one: string, many: string): string {
  return `${frontDoorNumber.format(count)} ${count === 1 ? one : many}`;
}
