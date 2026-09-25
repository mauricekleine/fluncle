import { oc } from "@orpc/contract";
import * as z from "zod";

export const GalaxyAdminItemSchema = z
  .object({
    centroid: z.array(z.number()),
    createdAt: z.string(),
    handle: z.string(),
    id: z.string(),
    memberCount: z.number(),
    name: z.string().nullable(),
    retiredAt: z.string().nullable(),
    silhouette: z.number().nullable(),
    slug: z.string().nullable(),
    splitRequestedAt: z.string().nullable(),
    updatedAt: z.string(),
  })
  .meta({ id: "GalaxyAdminItem" });

export const listGalaxiesAdmin = oc
  .route({
    method: "GET",
    operationId: "listGalaxiesAdmin",
    path: "/admin/galaxies",
    summary: "The full galaxy map (named + unnamed + retired, with centroids + evidence)",
    tags: ["Admin"],
  })
  .output(z.object({ galaxies: z.array(GalaxyAdminItemSchema), ok: z.literal(true) }));

export const updateGalaxy = oc
  .route({
    method: "PATCH",
    operationId: "updateGalaxy",
    path: "/admin/galaxies/{id}",
    summary: "Name, rename, or request a split of one galaxy (operator)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      id: z.string(),
      name: z.string().optional(),
      requestSplit: z.boolean().optional(),
      slug: z.string().optional(),
    }),
  )
  .output(z.object({ galaxy: GalaxyAdminItemSchema, ok: z.literal(true) }));

const MAX_GALAXY_CLUSTERS = 64;

const MAX_CENTROID_DIMENSIONS = 2048;

export const updateGalaxyMap = oc
  .route({
    method: "PUT",
    operationId: "updateGalaxyMap",
    path: "/admin/galaxies/map",
    summary: "Transactional galaxy-map write (upsert centroids, mint new ids, retire)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      clusters: z
        .array(
          z.object({
            centroid: z.array(z.number()).max(MAX_CENTROID_DIMENSIONS),

            clearSplitRequest: z.boolean().optional(),
            id: z.string().nullable(),
            retire: z.boolean().optional(),
          }),
        )
        .max(MAX_GALAXY_CLUSTERS),
    }),
  )
  .output(z.object({ galaxies: z.array(GalaxyAdminItemSchema), ok: z.literal(true) }));

export const TrackEmbeddingSchema = z
  .object({
    embedding: z.array(z.number()),
    galaxyId: z.string().nullable(),
    trackId: z.string(),
  })
  .meta({ id: "TrackEmbedding" });

export const listTrackEmbeddings = oc
  .route({
    method: "GET",
    operationId: "listTrackEmbeddings",
    path: "/admin/tracks/embeddings",
    summary: "The embedded corpus (trackId + MuQ vector), cursor-paginated (the cluster input)",
    tags: ["Admin"],
  })
  .input(z.object({ cursor: z.string().optional(), limit: z.string().optional() }))
  .output(
    z.object({
      embeddings: z.array(TrackEmbeddingSchema),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),
    }),
  );

export const adminGalaxiesContract = {
  list_galaxies_admin: listGalaxiesAdmin,
  list_track_embeddings: listTrackEmbeddings,
  update_galaxy: updateGalaxy,
  update_galaxy_map: updateGalaxyMap,
};
