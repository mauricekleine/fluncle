// The `artists` domain contract module — public artist-entity reads. Follows the
// `mixtapes` pattern: a list op and a by-slug get op, both public reads. `list_artists`
// serves the SAME unified `/artists` index the web page does — every artist Fluncle holds
// that clears the thin-content floor, paginated; the older findings-only, finding-count-
// ordered read is gone. `get_artist` resolves any artist that has a page.

import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * A public artist list item — the minimal shape the list and get ops emit. The
 * public identifier is `slug` (the internal surrogate `id` never crosses the wire);
 * these fields are sufficient for the CLI, SSH terminal, and llms.txt consumers, and
 * the `/artist/<slug>` page derives its richer shape from the same row. `findingCount`
 * counts published findings; `certified` is `findingCount > 0`; `trackCount` is the artist's
 * renderable tracks (findings plus the quieter catalogue rows).
 */
export const ArtistListItemSchema = z
  .object({
    certified: z.boolean(),
    findingCount: z.number(),
    name: z.string(),
    slug: z.string(),
    spotifyUrl: z.string().optional(),
    trackCount: z.number(),
  })
  .meta({ id: "ArtistListItem" });

/**
 * `list_artists` → `GET /artists` (operationId `listArtists`).
 *
 * The unified `/artists` index — every artist Fluncle holds that clears the thin-content floor,
 * ordered alphabetically by name, one page at a time. This is the SAME index the `/artists` web
 * page serves. `page` is a 1-based tolerant string query param (default 1); the page size is
 * fixed. Contract-only oRPC: there is no TanStack route file under /api/v1/artists; oRPC serves it
 * straight off the registry. The response is `{ ok: true, artists, page, pageCount, total }`.
 */
export const listArtists = oc
  .route({
    method: "GET",
    operationId: "listArtists",
    path: "/artists",
    summary: "List every artist Fluncle holds, A to Z, one page at a time",
    tags: ["Artists"],
  })
  .input(z.object({ page: z.string().optional() }))
  .output(
    z.object({
      artists: z.array(ArtistListItemSchema),
      ok: z.literal(true),
      page: z.number(),
      pageCount: z.number(),
      total: z.number(),
    }),
  );

/**
 * `get_artist` → `GET /artists/{slug}` (operationId `getArtist`).
 *
 * Public read of a single artist by their unique slug. Returns the same `ArtistListItem` shape as
 * the list, wrapped in `{ ok: true, artist }`. Resolves any artist that has a page — a below-floor,
 * crawled artist the list omits still renders on its `/artist/<slug>` page — so get is
 * intentionally wider than the list index. A slug that matches no artist is a 404.
 */
export const getArtist = oc
  .route({
    method: "GET",
    operationId: "getArtist",
    path: "/artists/{slug}",
    summary: "Get an artist by slug",
    tags: ["Artists"],
  })
  .input(z.object({ slug: z.string() }))
  .output(z.object({ artist: ArtistListItemSchema, ok: z.literal(true) }));

/**
 * `list_similar_artists` → `GET /artists/similar?slugs=a,b,c` (operationId `listSimilarArtists`).
 *
 * The artists sitting sonically nearest to the AVERAGE of the given artists' audio positions — the
 * "sounds like these" compare. `slugs` is a comma-separated list of 2+ artist slugs (capped at 6; a
 * blank/whitespace list resolves to none). The response is `{ ok: true, artists }` — up to twelve
 * `ArtistListItem`s ordered nearest first, the given artists excluded from their own results, each
 * carrying its `certified` flag (an uncertified neighbour is a real result, never a certified one).
 * A literal path under `/artists`, so it takes precedence over `/artists/{slug}` the same way
 * `/tracks/random` does over `/tracks/{idOrLogId}`. Contract-only oRPC; public, no auth.
 */
export const listSimilarArtists = oc
  .route({
    method: "GET",
    operationId: "listSimilarArtists",
    path: "/artists/similar",
    summary: "List the artists that sound most like a set of artists",
    tags: ["Artists"],
  })
  .input(z.object({ slugs: z.string() }))
  .output(z.object({ artists: z.array(ArtistListItemSchema), ok: z.literal(true) }));

/** The `artists` domain's ops, merged into the root contract by `./index.ts`. */
export const artistsContract = {
  get_artist: getArtist,
  list_artists: listArtists,
  list_similar_artists: listSimilarArtists,
};
