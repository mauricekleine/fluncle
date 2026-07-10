// The `galaxies` domain contract module — public reads of the sonic galaxy map
// (browse-by-feel RFC). The clusters ARE the galaxies: k-means regions over the MuQ
// embedding space, operator-named, that replaced the four vibe-quadrant galaxies.
// Follows the `artists` pattern: a plain list op and a by-slug get op, both public
// reads. The public identifier is `slug` (the internal surrogate `id` and the
// machine `handle` never cross the wire); an UNNAMED or RETIRED galaxy never appears
// on either op — naming mints the public URL.

import { oc } from "@orpc/contract";
import * as z from "zod";
import { TrackListItemSchema } from "./_shared";

/**
 * A public galaxy list item — the minimal shape the list and get ops emit. `slug` +
 * `name` are the operator-authored public identity (present only once named);
 * `memberCount` is DERIVED (`COUNT(*) GROUP BY galaxy_id`), never stored. Sufficient
 * for the CLI, the SSH terminal, llms.txt, and the `/galaxies` lens.
 */
export const GalaxyListItemSchema = z
  .object({
    memberCount: z.number(),
    name: z.string(),
    slug: z.string(),
  })
  .meta({ id: "GalaxyListItem" });

/**
 * `list_galaxies` → `GET /galaxies` (operationId `listGalaxies`).
 *
 * The named map: every operator-named, non-retired galaxy with its derived member
 * count. Contract-only oRPC (no TanStack route file under /api/v1/galaxies; oRPC
 * serves it straight off the registry). The response is `{ ok: true, galaxies }`,
 * mirroring the `list_artists` envelope. Unnamed and retired galaxies are excluded.
 */
export const listGalaxies = oc
  .route({
    method: "GET",
    operationId: "listGalaxies",
    path: "/galaxies",
    summary: "List the named sonic galaxies (the browse-by-feel map)",
    tags: ["Galaxies"],
  })
  .output(z.object({ galaxies: z.array(GalaxyListItemSchema), ok: z.literal(true) }));

/**
 * `get_galaxy` → `GET /galaxies/{slug}` (operationId `getGalaxy`).
 *
 * One named galaxy by its unique slug, plus its findings ordered by centroid-distance
 * ascending (the core of the galaxy first — the deterministic order a future radio
 * consumer needs). Findings are `TrackListItem`, public-stripped. Paginated in the
 * contract from day one (a galaxy can grow well past render size before the operator
 * splits it): `limit`/`offset` are tolerant optional strings parsed in-handler
 * (mirroring `list_tracks`), so a bad value degrades to the default rather than 400s.
 * A slug that names no named galaxy (or an unnamed/retired one) is a 404.
 */
export const getGalaxy = oc
  .route({
    method: "GET",
    operationId: "getGalaxy",
    path: "/galaxies/{slug}",
    summary: "Get a named galaxy by slug, with its findings (core-first, paginated)",
    tags: ["Galaxies"],
  })
  .input(
    z.object({ limit: z.string().optional(), offset: z.string().optional(), slug: z.string() }),
  )
  .output(
    z.object({
      findings: z.array(TrackListItemSchema),
      galaxy: GalaxyListItemSchema,
      ok: z.literal(true),
    }),
  );

/** The `galaxies` domain's ops, merged into the root contract by `./index.ts`. */
export const galaxiesContract = {
  get_galaxy: getGalaxy,
  list_galaxies: listGalaxies,
};
