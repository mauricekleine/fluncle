import { oc } from "@orpc/contract";
import * as z from "zod";

export const GalaxyProgressSchema = z
  .object({
    collectedLogIds: z.array(z.string()),
    deaths: z.number(),
    lastPlayedAt: z.string().optional(),
    ok: z.literal(true),
    updatedAt: z.string().optional(),
    wins: z.number(),
  })
  .meta({ id: "GalaxyProgress" });

const GalaxyMergeBodySchema = z.looseObject({
  collectedLogIds: z.unknown().optional(),
  deaths: z.unknown().optional(),
  wins: z.unknown().optional(),
});

const GalaxyLogBodySchema = z.looseObject({
  logId: z.unknown().optional(),
});

export const getPrivateGalaxyProgress = oc
  .route({
    method: "GET",
    operationId: "getPrivateGalaxyProgress",
    path: "/me/galaxy-progress",
    summary: "Get the signed-in user's Galaxy progress",
    tags: ["Me"],
  })
  .output(GalaxyProgressSchema);

export const mergePrivateGalaxyProgress = oc
  .route({
    method: "PUT",
    operationId: "mergePrivateGalaxyProgress",
    path: "/me/galaxy-progress",
    summary: "Merge local Galaxy progress into the server save",
    tags: ["Me"],
  })
  .input(GalaxyMergeBodySchema)
  .output(GalaxyProgressSchema);

export const collectPrivateGalaxyLog = oc
  .route({
    method: "POST",
    operationId: "collectPrivateGalaxyLog",
    path: "/me/galaxy-progress/logs",
    summary: "Collect a finding into the signed-in user's Galaxy log",
    tags: ["Me"],
  })
  .input(GalaxyLogBodySchema)
  .output(z.object({ logId: z.string(), ok: z.literal(true) }));

export const GalaxyCollectionItemSchema = z
  .object({
    artists: z.array(z.string()),
    firstCollectedAt: z.string(),
    galaxyName: z.string().optional(),
    galaxySlug: z.string().optional(),
    imageUrl: z.string().optional(),
    logId: z.string(),
    title: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "GalaxyCollectionItem" });

export const GalaxyCompletionSchema = z
  .object({
    collected: z.number(),
    name: z.string(),
    slug: z.string(),
    total: z.number(),
  })
  .meta({ id: "GalaxyCompletion" });

export const listPrivateGalaxyCollection = oc
  .route({
    method: "GET",
    operationId: "listPrivateGalaxyCollection",
    path: "/me/galaxy-collection",
    summary: "List the signed-in user's Galaxy collection",
    tags: ["Me"],
  })
  .output(
    z.object({
      collection: z.array(GalaxyCollectionItemSchema),
      galaxies: z.array(GalaxyCompletionSchema),
      ok: z.literal(true),
    }),
  );

export type GalaxyCollectionItem = z.infer<typeof GalaxyCollectionItemSchema>;
export type GalaxyCompletion = z.infer<typeof GalaxyCompletionSchema>;

export const meGalaxyContract = {
  collect_private_galaxy_log: collectPrivateGalaxyLog,
  get_private_galaxy_progress: getPrivateGalaxyProgress,
  list_private_galaxy_collection: listPrivateGalaxyCollection,
  merge_private_galaxy_progress: mergePrivateGalaxyProgress,
};
