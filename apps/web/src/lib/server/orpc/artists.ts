// The `artists` domain router module. Implements the public artist-read contract
// ops off the shared implementer the root (../orpc.ts) hands in. Mirrors the
// `mixtapes` pattern: list and get, both public, no auth.

import { ORPCError } from "@orpc/server";
import { getArtistListItemBySlug, listArtists } from "../artists";
import { apiFault, type Implementer } from "./_shared";

/**
 * Build the `artists` domain's handlers — public reads for the artist-entity
 * surface (Unit 4 of the artist-relationship RFC). Mirrors the `mixtapes`
 * pattern: list and get, both public, no auth.
 */
export function artistsHandlers(os: Implementer) {
  // `list_artists` — every artist with at least one published finding,
  // finding-count descending. Mirrors `list_mixtapes`: `{ ok: true, artists }`.
  const listArtistsHandler = os.list_artists.handler(async () => {
    try {
      return { artists: await listArtists(), ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  // `get_artist` — one artist by slug, 404 when absent (or when the slug has no
  // published finding — `getArtistListItemBySlug` returns undefined in both cases).
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
