// The `artists` domain router module. Implements the public artist-read contract
// ops off a domain-scoped sub-implementer (the full-contract Implementer cannot
// include these keys for TypeScript's type inference — see Unit 4 context).

import { implement, ORPCError } from "@orpc/server";
import { artistsContract } from "@fluncle/contracts/orpc";
import { type OrpcContext } from "../orpc-auth";
import { getArtistBySlug, listArtists } from "../artists";
import { apiFault, type Implementer } from "./_shared";

// A sub-implementer scoped to the artists contract. TypeScript reliably computes
// the mapped type for a 2-key contract; the full 97-op Implementer hits a type-
// inference limit that drops some keys (a known TS limitation for large contracts).
// Using implement<..., OrpcContext>() directly (not $context<>()) keeps
// TInitialContext = OrpcContext (not OrpcContext & Record<never, never>), which
// the router's Router<typeof contract, OrpcContext> constraint requires.
const artistsOs = implement<typeof artistsContract, OrpcContext>(artistsContract);

/**
 * Build the `artists` domain's handlers — public reads for the artist-entity
 * surface (Unit 4 of the artist-relationship RFC). Mirrors the `mixtapes`
 * pattern: list and get, both public, no auth.
 */
export function artistsHandlers(_os: Implementer) {
  // `list_artists` — every artist with at least one finding, finding-count
  // descending. Mirrors `list_mixtapes`: `{ ok: true, artists }` envelope.
  const listArtistsHandler = artistsOs.list_artists.handler(async () => {
    try {
      return { artists: await listArtists(), ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  // `get_artist` — one artist by slug, 404 when absent.
  const getArtistHandler = artistsOs.get_artist.handler(async ({ input }) => {
    try {
      const artist = await getArtistBySlug(input.slug);

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
