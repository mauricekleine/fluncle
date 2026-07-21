// The `artists` domain router module. Implements the public artist-read contract
// ops off the shared implementer the root (../orpc.ts) hands in. Mirrors the
// `mixtapes` pattern: list and get, both public, no auth. The list is the unified
// `/artists` catalogue index, paginated (`listArtistsApiPage`); `list_similar_artists`
// is the "sounds like these" multi-artist sonic read.

import { ORPCError } from "@orpc/server";
import { MAX_SIMILAR_ARTISTS_INPUT } from "../artist-dossier";
import { getArtistListItemBySlug, listArtistsApiPage, listSimilarArtistsApi } from "../artists";
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

  // `list_similar_artists` — the "sounds like these" sonic read over 1 to MAX anchors. `slugs` is the
  // comma-separated pool (1..MAX validated artist slugs; an empty / junk / over-cap request 400s
  // here, the get_mixable_order in-handler precedent). A single anchor takes the same averaged-probe
  // path — an average of one is itself. The ranking + exclusion of the given artists happens in
  // `listSimilarArtistsApi`.
  const listSimilarArtistsHandler = os.list_similar_artists.handler(async ({ input }) => {
    const slugs = [
      ...new Set(
        input.slugs
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];

    if (slugs.length < 1 || slugs.length > MAX_SIMILAR_ARTISTS_INPUT) {
      throw new ORPCError("BAD_REQUEST", {
        data: {
          apiCode: "invalid_request",
          apiMessage: `Provide 1 to ${MAX_SIMILAR_ARTISTS_INPUT} artist slugs to compare`,
        },
        message: `Provide 1 to ${MAX_SIMILAR_ARTISTS_INPUT} artist slugs to compare`,
      });
    }

    try {
      const artists = await listSimilarArtistsApi(slugs);

      return { artists, ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  return {
    get_artist: getArtistHandler,
    list_artists: listArtistsHandler,
    list_similar_artists: listSimilarArtistsHandler,
  };
}
