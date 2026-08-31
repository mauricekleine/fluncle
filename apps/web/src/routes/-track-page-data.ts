// The archive track destination's server-side resolution, lifted out of `track.$trackId.tsx` —
// the `-album-page-data.ts` / `-artist-page-data.ts` sibling-module pattern.
//
// WHY IT IS NOT IN THE ROUTE FILE. A route's `loader`, `head` and `validateSearch` are in the
// route's CRITICAL half: only the `component` is auto-split, so anything the route module reaches
// STATICALLY lands in the eager entry chunk that every page — the homepage included — downloads
// before first paint. A resolver referenced outside a `createServerFn().handler()` body keeps its
// `lib/server/**` imports alive in the client build, and those carry `getDb` → `@libsql/client` +
// `drizzle-orm` + all of `db/schema.ts` (docs/client-bundle.md rule 1, build-enforced by the
// `fluncle-eager-chunk-purity` gate in vite.config.ts).
//
// So the resolver lives here, the route reaches it by a DYNAMIC import inside the handler, and the
// route keeps only `import type`, which erases. The function stays exported and side-effect-free,
// so the unit suite drives it directly against a real database.

import {
  listSonicNeighbours,
  readTrackDestination,
  type SonicNeighbour,
  type TrackDestination,
} from "@/lib/server/track-page";

export type TrackPageData =
  | {
      neighbours: SonicNeighbour[];
      status: "found";
      track: TrackDestination;
    }
  /**
   * The recording's one destination is somewhere else, permanently. Two rows take this arm and
   * both are 301s the archive owes forever:
   *
   *   - a CERTIFIED track, whose destination is `/log/<coordinate>` and always was. This route
   *     never renders one, never mints a second URL for one, and never changes what `/log` means;
   *     it exists so a `/track/<id>` link built from a track id still lands on the right page.
   *   - a stamped DUPLICATE, whose principal is the row the operator ruled is the real one. The
   *     twin keeps its own permanent id, and the id keeps resolving — to the page that exists.
   */
  | { status: "redirect"; logId?: string; trackId?: string }
  | { status: "missing" };

/**
 * Resolve one archive track's destination.
 *
 * The neighbours are fetched only once the row is known to RENDER: a certified track redirects and
 * a missing one 404s, and neither pays for a vector scan it will not show. When the scan comes back
 * empty — no embedding yet, an empty corpus, or a dark sonar — the page renders no neighbour band
 * at all rather than an empty one, which is the same conditional-band rule every graph page follows
 * (docs/album-entity.md: a section renders only when it has content).
 */
export async function resolveTrackPageData(trackId: string): Promise<TrackPageData> {
  const row = await readTrackDestination(trackId);

  if (row.kind === "missing") {
    return { status: "missing" };
  }

  if (row.kind === "certified") {
    return { logId: row.logId, status: "redirect" };
  }

  if (row.kind === "duplicate") {
    return { status: "redirect", trackId: row.principalTrackId };
  }

  return {
    neighbours: await listSonicNeighbours(row.track.trackId),
    status: "found",
    track: row.track,
  };
}
