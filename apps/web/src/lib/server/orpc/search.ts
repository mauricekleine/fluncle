import { ORPCError } from "@orpc/server";
import { chargeRateLimit } from "../rate-limit";
import { searchArchive } from "../search";
import { searchTracks } from "../track-search";
import { apiFault, type Implementer } from "./_shared";

export const MIN_QUERY_LENGTH = 2;

const SEARCH_LIMIT = 30;
const SEARCH_WINDOW_MS = 60 * 1000;

export function searchHandlers(os: Implementer) {
  const searchTracksHandler = os.search_tracks.handler(async ({ context, input }) => {
    const query = input.q?.trim() ?? "";

    if (query.length < MIN_QUERY_LENGTH) {
      throw new ORPCError("BAD_REQUEST", {
        data: {
          apiCode: "invalid_query",
          apiMessage: "Search query must be at least 2 characters",
        },
        message: "Search query must be at least 2 characters",
      });
    }

    try {
      return {
        ok: true,
        results: await searchTracks({ query, request: context.request }),
      } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  const searchArchiveHandler = os.search_archive.handler(async ({ context, input }) => {
    const query = input.q.trim();

    if (query.length < MIN_QUERY_LENGTH) {
      return { degraded: false, entities: [], kind: "empty", ok: true, results: [] } as const;
    }

    try {
      const charge = await chargeRateLimit({
        action: "search_archive",
        limit: SEARCH_LIMIT,
        request: context.request,
        windowMs: SEARCH_WINDOW_MS,
      });
      const result = await searchArchive({
        beforeModel: charge.requireAllowed,
        limit: input.limit,
        q: query,
      });

      charge.throwIfLimited();

      return { ok: true, ...result } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  return { search_archive: searchArchiveHandler, search_tracks: searchTracksHandler };
}
