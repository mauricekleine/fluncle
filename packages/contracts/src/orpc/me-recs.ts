import { oc } from "@orpc/contract";
import * as z from "zod";

export const RecSeedSchema = z
  .object({
    addedAt: z.string(),
    artists: z.array(z.string()),

    imageUrl: z.string().optional(),
    logId: z.string().optional(),
    title: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "RecSeed" });

export const RecommendationFindingSchema = z
  .object({
    artists: z.array(z.string()),

    bpm: z.number().optional(),
    durationMs: z.number().optional(),
    imageUrl: z.string().optional(),
    key: z.string().optional(),
    label: z.string().optional(),
    logId: z.string(),
    note: z.string().optional(),
    similarity: z.number(),
    spotifyUri: z.string().optional(),
    spotifyUrl: z.string().optional(),
    title: z.string(),
    trackId: z.string(),
    year: z.string().optional(),
  })
  .meta({ id: "RecommendationFinding" });

export const RecommendationCatalogueSchema = z
  .object({
    artists: z.array(z.string()),

    bpm: z.number().optional(),
    durationMs: z.number().optional(),
    imageUrl: z.string().optional(),
    key: z.string().optional(),
    label: z.string().optional(),
    similarity: z.number(),
    spotifyUri: z.string().optional(),
    spotifyUrl: z.string().optional(),
    title: z.string(),
    trackId: z.string(),
    year: z.string().optional(),
  })
  .meta({ id: "RecommendationCatalogue" });

const SaveRecSeedBodySchema = z.looseObject({
  logId: z.unknown().optional(),
  trackId: z.unknown().optional(),
});

export const listPrivateRecSeeds = oc
  .route({
    method: "GET",
    operationId: "listPrivateRecSeeds",
    path: "/me/rec-seeds",
    summary: "List the signed-in user's recommendation seeds",
    tags: ["Me"],
  })
  .output(z.object({ ok: z.literal(true), seeds: z.array(RecSeedSchema) }));

export const savePrivateRecSeed = oc
  .route({
    method: "POST",
    operationId: "savePrivateRecSeed",
    path: "/me/rec-seeds",
    summary: "Add a recommendation seed for the signed-in user",
    tags: ["Me"],
  })
  .input(SaveRecSeedBodySchema)
  .output(
    z.object({
      ok: z.literal(true),
      seed: z.object({
        addedAt: z.string(),
        logId: z.string().optional(),
        trackId: z.string(),
      }),
    }),
  );

export const deletePrivateRecSeed = oc
  .route({
    method: "DELETE",
    operationId: "deletePrivateRecSeed",
    path: "/me/rec-seeds/{trackId}",
    summary: "Remove a recommendation seed for the signed-in user",
    tags: ["Me"],
  })
  .input(z.object({ trackId: z.string() }))
  .output(z.object({ ok: z.literal(true) }));

export const listPrivateRecommendations = oc
  .route({
    method: "GET",
    operationId: "listPrivateRecommendations",
    path: "/me/recommendations",
    summary: "List the signed-in user's recommendations from their seeds",
    tags: ["Me"],
  })
  .output(
    z.object({
      catalogue: z.array(RecommendationCatalogueSchema),
      findings: z.array(RecommendationFindingSchema),
      ok: z.literal(true),
      seedsSkipped: z.array(z.string()),
      seedsUsed: z.number(),
    }),
  );

export const meRecsContract = {
  delete_private_rec_seed: deletePrivateRecSeed,
  list_private_rec_seeds: listPrivateRecSeeds,
  list_private_recommendations: listPrivateRecommendations,
  save_private_rec_seed: savePrivateRecSeed,
};
