// The `search_tracks` capability: Spotify candidate search for the submit flow,
// behind ONE limiter and ONE cache — shared by BOTH public mounts.
//
// search_tracks is the ONE unauthenticated surface that burns the operator's
// shared Spotify token on every call, and it is mounted TWICE: as the public
// oRPC op (GET /api/v1/search, ./orpc/search.ts) and as an MCP tool on the
// anonymous /mcp endpoint (../mcp.ts). A guard on only one of them is not a
// guard: the other mount is the bypass. So the guard lives HERE, in the one
// function both mounts call, rather than in either handler.
//
// The raw vendor call is `searchTrackCandidates` in ./spotify — reached directly
// only by the internal paths that are not public floods (the anchor resolver,
// submit_track's URL lookup).

import { assertRateLimit } from "./rate-limit";
import { searchTrackCandidates, type TrackSearchResult } from "./spotify";

// A flood drains the token's quota for everyone, so this gets the shared atomic
// limiter — generous enough for the live submit-dialog type-ahead (one real user
// fires a few searches per submission), tight enough that a script can't grind the
// token. Keyed on hash(cf-connecting-ip) (anonymous; neither mount carries a session
// for this read). Both mounts pass the same `action`, so they share ONE per-IP budget.
export const SEARCH_TRACKS_LIMIT = 30;
export const SEARCH_TRACKS_WINDOW_MS = 60 * 1000;

// A short server-side cache of recent queries. Type-ahead re-issues the same
// prefix repeatedly and many callers search the same popular tracks; serving a
// recent identical query from memory spares the Spotify token entirely. Low-risk:
// results are public and change slowly, the TTL is short, and the map is bounded.
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const searchCache = new Map<string, { expiresAt: number; results: TrackSearchResult[] }>();

/**
 * The guarded, cached Spotify candidate search every public mount goes through.
 *
 * The limiter runs FIRST and a cache hit still counts, so a flood of cache-busting
 * queries can't grind the token under the cache. Over the limit it throws the shared
 * `ApiError("rate_limited", …, 429)` — which the oRPC rails encode as a 429 body and
 * the MCP dispatcher renders as an `isError` tool result.
 */
export async function searchTracks({
  query,
  request,
}: {
  query: string;
  request: Request;
}): Promise<TrackSearchResult[]> {
  await assertRateLimit({
    action: "search_tracks",
    limit: SEARCH_TRACKS_LIMIT,
    request,
    windowMs: SEARCH_TRACKS_WINDOW_MS,
  });

  return cachedSearch(query);
}

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
// between test files that exercise either mount. Production never calls it.
export function __resetSearchCache(): void {
  searchCache.clear();
}
