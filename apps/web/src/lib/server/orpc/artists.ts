import { ORPCError } from "@orpc/server";
import { MAX_SIMILAR_ARTISTS_INPUT } from "../artist-dossier";
import { getArtistListItemBySlug, listArtistsApiPage, listSimilarArtistsApi } from "../artists";
import { apiFault, type Implementer, parseCataloguePage } from "./_shared";

export function artistsHandlers(os: Implementer) {
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
