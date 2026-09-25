import { oc } from "@orpc/contract";
import * as z from "zod";

export const AlbumListItemSchema = z
  .object({
    certified: z.boolean(),
    coverImageUrl: z.string().optional(),
    findingCount: z.number(),
    name: z.string(),
    slug: z.string(),
    trackCount: z.number(),
  })
  .meta({ id: "AlbumListItem" });

export const AlbumDetailSchema = z
  .object({
    bio: z.string().optional(),
    certified: z.boolean(),
    coverImageUrl: z.string().optional(),
    findingCount: z.number(),
    name: z.string(),
    releaseDate: z.string().optional(),
    releaseGroupMbid: z.string().optional(),
    slug: z.string(),
    trackCount: z.number(),
    upc: z.string().optional(),
  })
  .meta({ id: "AlbumDetail" });

export const listAlbums = oc
  .route({
    method: "GET",
    operationId: "listAlbums",
    path: "/albums",
    summary: "List every album Fluncle holds, A to Z, one page at a time",
    tags: ["Albums"],
  })
  .input(z.object({ page: z.string().optional() }))
  .output(
    z.object({
      albums: z.array(AlbumListItemSchema),
      ok: z.literal(true),
      page: z.number(),
      pageCount: z.number(),
      total: z.number(),
    }),
  );

export const getAlbum = oc
  .route({
    method: "GET",
    operationId: "getAlbum",
    path: "/albums/{slug}",
    summary: "Get an album by slug",
    tags: ["Albums"],
  })
  .input(z.object({ slug: z.string() }))
  .output(z.object({ album: AlbumDetailSchema, ok: z.literal(true) }));

export const albumsContract = {
  get_album: getAlbum,
  list_albums: listAlbums,
};
