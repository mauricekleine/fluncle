// The `galaxies` domain router module — public reads of the sonic galaxy map
// (browse-by-feel RFC). Mirrors the `artists` pattern: list and get, both public, no
// auth. The backing functions (`../galaxies-map`) are shared with the admin handlers
// and (Slice 4) the `/galaxies` route loaders.

import { ORPCError } from "@orpc/server";
import { GalaxyNotFoundError, getPublicGalaxyBySlug, listPublicGalaxies } from "../galaxies-map";
import { apiFault, type Implementer, parseLimit } from "./_shared";

// The `get_galaxy` page bounds — a galaxy can grow well past render size before the
// operator splits it, so it is paginated from day one. Tolerant string parse (a bad
// value degrades to the default, never 400s — the `list_findings` habit).
const GALAXY_FINDINGS_DEFAULT_LIMIT = 24;
const GALAXY_FINDINGS_MAX_LIMIT = 100;

function parseOffset(value: string | undefined): number {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Build the `galaxies` domain's handlers — public reads for the browse-by-feel lens.
 */
export function galaxiesHandlers(os: Implementer) {
  // `list_galaxies` — every named, non-retired galaxy with its derived member count.
  // Held behind the launch gate: an empty list until the WHOLE map is named (the
  // public lens ships all at once — browse-by-feel RFC decision 5).
  const listGalaxiesHandler = os.list_galaxies.handler(async () => {
    try {
      return { galaxies: await listPublicGalaxies(), ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  // `get_galaxy` — one named galaxy by slug + its findings (core-first, paginated). A
  // slug that names no named galaxy (or an unnamed/retired one) is a 404; so is EVERY
  // slug while the map is only partially named (the launch gate).
  const getGalaxyHandler = os.get_galaxy.handler(async ({ input }) => {
    try {
      const { findings, galaxy } = await getPublicGalaxyBySlug(
        input.slug,
        parseLimit(input.limit, GALAXY_FINDINGS_DEFAULT_LIMIT, GALAXY_FINDINGS_MAX_LIMIT),
        parseOffset(input.offset),
      );

      return { findings, galaxy, ok: true } as const;
    } catch (error) {
      if (error instanceof GalaxyNotFoundError) {
        throw new ORPCError("NOT_FOUND", { message: error.message });
      }

      throw apiFault(error);
    }
  });

  return { get_galaxy: getGalaxyHandler, list_galaxies: listGalaxiesHandler };
}
