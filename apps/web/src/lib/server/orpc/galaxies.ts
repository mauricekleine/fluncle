import { ORPCError } from "@orpc/server";
import { GalaxyNotFoundError, getPublicGalaxyBySlug, listPublicGalaxies } from "../galaxies-map";
import { apiFault, type Implementer, parseLimit } from "./_shared";

const GALAXY_FINDINGS_DEFAULT_LIMIT = 24;
const GALAXY_FINDINGS_MAX_LIMIT = 100;

function parseOffset(value: string | undefined): number {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function galaxiesHandlers(os: Implementer) {
  const listGalaxiesHandler = os.list_galaxies.handler(async () => {
    try {
      return { galaxies: await listPublicGalaxies(), ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

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
