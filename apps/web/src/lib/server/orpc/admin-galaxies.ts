import {
  GalaxyNotFoundError,
  listGalaxiesAdmin,
  listTrackEmbeddingsPage,
  updateGalaxyFields,
  updateGalaxyMap,
} from "../galaxies-map";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { ORPCError } from "@orpc/server";
import { apiFault, type Implementer, parseLimit } from "./_shared";

const EMBEDDINGS_DEFAULT_LIMIT = 200;
const EMBEDDINGS_MAX_LIMIT = 500;

export function adminGalaxiesHandlers(os: Implementer) {
  const listGalaxiesAdminHandler = os.list_galaxies_admin.use(adminAuth).handler(async () => {
    try {
      return { galaxies: await listGalaxiesAdmin(), ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  const updateGalaxyHandler = os.update_galaxy
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const galaxy = await updateGalaxyFields(input.id, {
          name: input.name,
          requestSplit: input.requestSplit,
          slug: input.slug,
        });

        return { galaxy, ok: true } as const;
      } catch (error) {
        if (error instanceof GalaxyNotFoundError) {
          throw new ORPCError("NOT_FOUND", { message: error.message });
        }

        throw apiFault(error);
      }
    });

  const updateGalaxyMapHandler = os.update_galaxy_map.use(adminAuth).handler(async ({ input }) => {
    try {
      return { galaxies: await updateGalaxyMap(input.clusters), ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  const listTrackEmbeddingsHandler = os.list_track_embeddings
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const { embeddings, nextCursor } = await listTrackEmbeddingsPage(
          input.cursor,
          parseLimit(input.limit, EMBEDDINGS_DEFAULT_LIMIT, EMBEDDINGS_MAX_LIMIT),
        );

        return { embeddings, nextCursor, ok: true } as const;
      } catch (error) {
        throw apiFault(error);
      }
    });

  return {
    list_galaxies_admin: listGalaxiesAdminHandler,
    list_track_embeddings: listTrackEmbeddingsHandler,
    update_galaxy: updateGalaxyHandler,
    update_galaxy_map: updateGalaxyMapHandler,
  };
}
