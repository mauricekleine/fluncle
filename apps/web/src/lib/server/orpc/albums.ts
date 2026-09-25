import { ORPCError } from "@orpc/server";
import { getAlbumDetail, listAlbumsApiPage } from "../albums";
import { apiFault, type Implementer, parseCataloguePage } from "./_shared";

export function albumsHandlers(os: Implementer) {
  const listAlbumsHandler = os.list_albums.handler(async ({ input }) => {
    try {
      const { items, page, pageCount, total } = await listAlbumsApiPage(
        parseCataloguePage(input.page),
      );

      return { albums: items, ok: true, page, pageCount, total } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  const getAlbumHandler = os.get_album.handler(async ({ input }) => {
    try {
      const album = await getAlbumDetail(input.slug);

      if (!album) {
        throw new ORPCError("NOT_FOUND", {
          message: `No album with slug "${input.slug}"`,
        });
      }

      return { album, ok: true } as const;
    } catch (error) {
      if (error instanceof ORPCError) {
        throw error;
      }

      throw apiFault(error);
    }
  });

  return { get_album: getAlbumHandler, list_albums: listAlbumsHandler };
}
