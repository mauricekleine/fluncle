// The `albums` domain router module — public album reads over the catalogue. Mirrors
// the `artists` pattern: a paginated list and a by-slug get, both public, no auth. The
// backing functions live in `../albums` (`listAlbumsApiPage` / `getAlbumDetail`).
//
// NOTE: the admin album ops (bio authoring, worklists) live in `./admin-albums.ts`; this
// is the PUBLIC read domain and shares no handler factory with it.

import { ORPCError } from "@orpc/server";
import { getAlbumDetail, listAlbumsApiPage } from "../albums";
import { apiFault, type Implementer, parseCataloguePage } from "./_shared";

/** Build the `albums` domain's PUBLIC read handlers — list + get, both no-auth. */
export function albumsHandlers(os: Implementer) {
  // `list_albums` — the unified `/albums` index over the API, one page at a time.
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

  // `get_album` — one album by slug, 404 when no album carries it.
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
