import { oc } from "@orpc/contract";
import * as z from "zod";

export const mintPrivateFrontierPlaylist = oc
  .route({
    method: "POST",
    operationId: "mintPrivateFrontierPlaylist",
    path: "/me/frontier-playlist",
    summary: "Mint or refresh the signed-in user's Frontier playlist",
    tags: ["Me"],
  })
  .input(z.looseObject({}))
  .output(
    z.object({
      ok: z.literal(true),
      playlistUrl: z.string().optional(),
      status: z.enum(["minted", "refreshed", "unchanged", "edition_only", "building"]),
    }),
  );

export const getPrivateFrontierPlaylist = oc
  .route({
    method: "GET",
    operationId: "getPrivateFrontierPlaylist",
    path: "/me/frontier-playlist",
    summary: "Read the signed-in user's Frontier playlist state",
    tags: ["Me"],
  })
  .output(
    z.object({
      lastSyncedAt: z.string().optional(),
      mintingOpen: z.boolean(),
      ok: z.literal(true),
      playlistUrl: z.string().optional(),
    }),
  );

export const FrontierEditionSummarySchema = z.object({
  number: z.number(),
  refreshedAt: z.string(),
  seedsSkipped: z.array(z.string()).optional(),
  seedsUsed: z.number().optional(),
  trackCount: z.number(),
});

export const FrontierEditionTrackSchema = z.object({
  artists: z.array(z.string()),
  bpm: z.number().optional(),
  durationMs: z.number().optional(),
  imageUrl: z.string().optional(),
  key: z.string().optional(),
  logId: z.string().optional(),
  similarity: z.number().optional(),
  slot: z.enum(["catalogue", "finding"]),
  spotifyUrl: z.string().optional(),
  title: z.string(),
  trackId: z.string(),
});

export const listPrivateFrontierEditions = oc
  .route({
    method: "GET",
    operationId: "listPrivateFrontierEditions",
    path: "/me/frontier-editions",
    summary: "List the signed-in user's frozen Frontier editions",
    tags: ["Me"],
  })
  .output(
    z.object({
      editions: z.array(FrontierEditionSummarySchema),
      ok: z.literal(true),
    }),
  );

export const getPrivateFrontierEdition = oc
  .route({
    method: "GET",
    operationId: "getPrivateFrontierEdition",
    path: "/me/frontier-editions/{number}",
    summary: "Get one of the signed-in user's frozen Frontier editions",
    tags: ["Me"],
  })
  .input(z.object({ number: z.string() }))
  .output(
    z.object({
      edition: FrontierEditionSummarySchema,
      ok: z.literal(true),
      tracks: z.array(FrontierEditionTrackSchema),
    }),
  );

export const meFrontierContract = {
  get_private_frontier_edition: getPrivateFrontierEdition,
  get_private_frontier_playlist: getPrivateFrontierPlaylist,
  list_private_frontier_editions: listPrivateFrontierEditions,
  mint_private_frontier_playlist: mintPrivateFrontierPlaylist,
};
