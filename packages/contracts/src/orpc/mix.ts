import { oc } from "@orpc/contract";
import * as z from "zod";

import { MixTrackSchema } from "./_shared.js";

export const MixArtistSchema = z
  .object({
    imageUrl: z.string().optional(),
    name: z.string(),
    slug: z.string(),
    trackCount: z.number(),
  })
  .meta({ id: "MixArtist" });

export const listMixableArtists = oc
  .route({
    method: "GET",
    operationId: "listMixableArtists",
    path: "/mix/artists",
    summary: "List the artists a mix can be seeded from",
    tags: ["Mix"],
  })
  .input(z.object({ limit: z.string().optional(), q: z.string().max(200).optional() }))
  .output(z.object({ artists: z.array(MixArtistSchema), ok: z.literal(true) }));

export const listMixOpeners = oc
  .route({
    method: "GET",
    operationId: "listMixOpeners",
    path: "/mix/openers",
    summary: "List the tracks to open a set with, for a seed of artists you like",
    tags: ["Mix"],
  })
  .input(z.object({ limit: z.string().optional(), taste: z.string() }))
  .output(z.object({ ok: z.literal(true), tracks: z.array(MixTrackSchema) }));

export const listSetTracks = oc
  .route({
    method: "GET",
    operationId: "listSetTracks",
    path: "/mix/set-tracks",
    summary: "Hydrate a whole shared set from its comma-separated token list",
    tags: ["Mix"],
  })
  .input(z.object({ set: z.string() }))
  .output(z.object({ ok: z.literal(true), tracks: z.array(MixTrackSchema) }));

export const mixContract = {
  list_mix_openers: listMixOpeners,
  list_mixable_artists: listMixableArtists,
  list_set_tracks: listSetTracks,
};
