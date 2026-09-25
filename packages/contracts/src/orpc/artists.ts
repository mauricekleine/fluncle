import { oc } from "@orpc/contract";
import * as z from "zod";

export const ArtistListItemSchema = z
  .object({
    certified: z.boolean(),
    findingCount: z.number(),
    name: z.string(),
    slug: z.string(),
    spotifyUrl: z.string().optional(),
    trackCount: z.number(),
  })
  .meta({ id: "ArtistListItem" });

export const listArtists = oc
  .route({
    method: "GET",
    operationId: "listArtists",
    path: "/artists",
    summary: "List every artist Fluncle holds, A to Z, one page at a time",
    tags: ["Artists"],
  })
  .input(z.object({ page: z.string().optional() }))
  .output(
    z.object({
      artists: z.array(ArtistListItemSchema),
      ok: z.literal(true),
      page: z.number(),
      pageCount: z.number(),
      total: z.number(),
    }),
  );

export const getArtist = oc
  .route({
    method: "GET",
    operationId: "getArtist",
    path: "/artists/{slug}",
    summary: "Get an artist by slug",
    tags: ["Artists"],
  })
  .input(z.object({ slug: z.string() }))
  .output(z.object({ artist: ArtistListItemSchema, ok: z.literal(true) }));

export const listSimilarArtists = oc
  .route({
    method: "GET",
    operationId: "listSimilarArtists",
    path: "/artists/similar",
    summary: "List the artists that sound most like a set of artists",
    tags: ["Artists"],
  })
  .input(z.object({ slugs: z.string() }))
  .output(z.object({ artists: z.array(ArtistListItemSchema), ok: z.literal(true) }));

export const artistsContract = {
  get_artist: getArtist,
  list_artists: listArtists,
  list_similar_artists: listSimilarArtists,
};
