// The `artists` domain router module. Implements the public artist-read contract
// ops off the shared implementer the root (../orpc.ts) hands in. Mirrors the
// `mixtapes` pattern: list and get, both public, no auth. The list is the unified
// `/artists` catalogue index, paginated (`listArtistsApiPage`).

import { ORPCError } from "@orpc/server";
import { getArtistListItemBySlug, listArtistsApiPage } from "../artists";
import { apiFault, type Implementer, parseCataloguePage } from "./_shared";

/**
 * Build the `artists` domain's handlers — public reads for the artist-entity surface.
 * Mirrors the `mixtapes` pattern: list and get, both public, no auth.
 */
export function artistsHandlers(os: Implementer) {
  // `list_artists` — the unified `/artists` index over the API, one page at a time.
  const listArtistsHandler = os.list_artists.handler(async ({ input }) => {
    try {
      const { items, page, pageCount, total } = await listArtistsApiPage(
        parseCataloguePage(input.page),
      );

      return { artists: items, ok: true, page, pageCount, total } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  // `get_artist` — one artist by slug, 404 when absent (`getArtistListItemBySlug`
  // returns undefined when no artist carries the slug).
  const getArtistHandler = os.get_artist.handler(async ({ input }) => {
    try {
      const artist = await getArtistListItemBySlug(input.slug);

      if (!artist) {
        throw new ORPCError("NOT_FOUND", {
          message: `No artist with slug "${input.slug}"`,
        });
      }

      return { artist, ok: true } as const;
    } catch (error) {
      if (error instanceof ORPCError) {
        throw error;
      }

      throw apiFault(error);
    }
  });

  return { get_artist: getArtistHandler, list_artists: listArtistsHandler };
}
