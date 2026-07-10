// The `admin-galaxies` domain router module — the sonic galaxy map's admin surface
// (browse-by-feel RFC). Four ops on the artist-domain pattern (auth relocated to the
// procedure middleware):
//
//   - `list_galaxies_admin` — `adminAuth` (agent-allowed read): the full map for the
//     naming view + the cron's map read.
//   - `update_galaxy` — `adminAuth` + `operatorGuard` (OPERATOR): naming is publish-class
//     (mints a public URL), so the box's agent token 403s — the `note`/OPERATOR_ONLY
//     precedent applied to galaxies.
//   - `update_galaxy_map` — `adminAuth`: the cron's transactional map write; the Worker
//     mints new ids + handles server-side.
//   - `list_track_embeddings` — `adminAuth`: the embedded corpus, cursor-paginated (the
//     cluster engine's input).

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

// The cluster engine reads the corpus in cursor pages; a generous default keeps the
// nightly sweep's round-trips low, capped so one page never blows the response budget.
const EMBEDDINGS_DEFAULT_LIMIT = 200;
const EMBEDDINGS_MAX_LIMIT = 500;

/**
 * Build the `admin-galaxies` domain's handlers.
 */
export function adminGalaxiesHandlers(os: Implementer) {
  // GET /admin/galaxies — `adminAuth` (operator OR agent): the full map (named +
  // unnamed + retired), each with centroid + derived member count. The cron reads the
  // prior map + split flags here.
  const listGalaxiesAdminHandler = os.list_galaxies_admin.use(adminAuth).handler(async () => {
    try {
      return { galaxies: await listGalaxiesAdmin(), ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  // PATCH /admin/galaxies/{id} — OPERATOR tier: name/rename/request-split. An agent
  // token 403s at `operatorGuard` (naming mints a public URL).
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

  // PUT /admin/galaxies/map — `adminAuth` (the cron's agent token): the transactional
  // map write. The Worker mints ids + handles for new clusters and returns the map.
  const updateGalaxyMapHandler = os.update_galaxy_map.use(adminAuth).handler(async ({ input }) => {
    try {
      return { galaxies: await updateGalaxyMap(input.clusters), ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  // GET /admin/tracks/embeddings — `adminAuth` (the cron's agent token): the embedded
  // corpus, cursor-paginated over track_id.
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
