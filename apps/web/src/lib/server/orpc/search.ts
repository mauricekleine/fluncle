// The `search` domain router module. Implements the public Spotify-candidate
// search contract op off the shared implementer the root (../orpc.ts) hands in.
// A future wave adds an op here and one spread line in the root — no other
// domain's file is touched.

import { ORPCError } from "@orpc/server";
import { assertRateLimit } from "../rate-limit";
import { searchTrackCandidates, type TrackSearchResult } from "../spotify";
import { apiFault, type Implementer } from "./_shared";

// The live /api/search short-query gate, ported verbatim.
const MIN_QUERY_LENGTH = 2;

// search_tracks is the ONE unauthenticated surface that burns the operator's
// shared Spotify token on every call. A flood drains the token's quota for
// everyone, so it gets the shared atomic limiter — generous enough for the live
// submit-dialog type-ahead (one real user fires a few searches per submission),
// tight enough that a script can't grind the token. Keyed on hash(cf-connecting-ip)
// (anonymous; the contract carries no session for this read).
const SEARCH_LIMIT = 30;
const SEARCH_WINDOW_MS = 60 * 1000;

// A short server-side cache of recent queries. Type-ahead re-issues the same
// prefix repeatedly and many callers search the same popular tracks; serving a
// recent identical query from memory spares the Spotify token entirely. Low-risk:
// results are public and change slowly, the TTL is short, and the map is bounded.
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const searchCache = new Map<string, { expiresAt: number; results: TrackSearchResult[] }>();

async function cachedSearch(query: string): Promise<TrackSearchResult[]> {
  const key = query.toLowerCase();
  const now = Date.now();
  const hit = searchCache.get(key);

  if (hit && hit.expiresAt > now) {
    return hit.results;
  }

  const results = await searchTrackCandidates(query);

  searchCache.set(key, { expiresAt: now + CACHE_TTL_MS, results });

  // Bound the map: drop the oldest insertion when it overflows (Map preserves
  // insertion order, so the first key is the oldest).
  if (searchCache.size > CACHE_MAX_ENTRIES) {
    const oldest = searchCache.keys().next().value;

    if (oldest !== undefined) {
      searchCache.delete(oldest);
    }
  }

  return results;
}

// Test seam: clear the recent-query cache so a module-level entry can't leak
// between test files that exercise the search handler. Production never calls it.
export function __resetSearchCache(): void {
  searchCache.clear();
}

/**
 * Build the `search` domain's handlers — a direct port of the live /api/search
 * route, preserving the `{ ok: true, results }` envelope byte-for-byte. The
 * short-query 400 is carried as fault data so the rails encoder reproduces the
 * exact `invalid_query`/400 body the live route hand-rolled (not the generic
 * `bad_request` mapping); upstream Spotify faults flow through `apiFault`.
 */
export function searchHandlers(os: Implementer) {
  // `search_tracks` — Spotify candidate search for the submit flow. Port of
  // /api/search GET: trim the `q` param, 400 with `invalid_query` when under the
  // length floor, else the `{ ok: true, results }` envelope.
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
      // Guard the shared Spotify token first; a cache hit still counts so a flood
      // of cache-busting queries can't grind the token under the cache.
      await assertRateLimit({
        action: "search_tracks",
        limit: SEARCH_LIMIT,
        request: context.request,
        windowMs: SEARCH_WINDOW_MS,
      });

      return { ok: true, results: await cachedSearch(query) } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  return { search_tracks: searchTracksHandler };
}
