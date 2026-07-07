// The `artists` domain contract module — public artist-entity reads (Unit 4 of
// the artist-relationship RFC). Follows the `mixtapes` pattern: a plain list op
// and a by-slug get op, both public reads.

import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * A public artist list item — the minimal shape the list and get ops emit. Carries
 * identity fields sufficient for the CLI, SSH terminal, and llms.txt consumers;
 * the `/artist/<slug>` page (Unit 3) derives its richer shape from the same row.
 */
export const ArtistListItemSchema = z
  .object({
    findingCount: z.number(),
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    spotifyUrl: z.string().optional(),
  })
  .meta({ id: "ArtistListItem" });

/**
 * `list_artists` → `GET /artists` (operationId `listArtists`).
 *
 * Every artist with at least one finding, ordered by finding count descending (the
 * most-represented artists first). Contract-only oRPC: there is no TanStack route
 * file under /api/v1/artists; oRPC serves it straight off the registry. The
 * response is `{ ok: true, artists }`, mirroring the `list_mixtapes` envelope.
 */
export const listArtists = oc
  .route({
    method: "GET",
    operationId: "listArtists",
    path: "/artists",
    summary: "List artists with at least one finding",
    tags: ["Artists"],
  })
  .output(z.object({ artists: z.array(ArtistListItemSchema), ok: z.literal(true) }));

/**
 * `get_artist` → `GET /artists/{slug}` (operationId `getArtist`).
 *
 * Public read of a single artist by their unique slug. Returns the same
 * `ArtistListItem` shape as the list, wrapped in `{ ok: true, artist }`. A slug
 * that does not match any artist row is a 404.
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

/** The `artists` domain's ops, merged into the root contract by `./index.ts`. */
export const artistsContract = {
  get_artist: getArtist,
  list_artists: listArtists,
};
