import { assertRateLimit } from "./rate-limit";
import { searchTrackCandidates, type TrackSearchResult } from "./spotify";

export const SEARCH_TRACKS_LIMIT = 30;
export const SEARCH_TRACKS_WINDOW_MS = 60 * 1000;

const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const searchCache = new Map<string, { expiresAt: number; results: TrackSearchResult[] }>();

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

  if (searchCache.size > CACHE_MAX_ENTRIES) {
    const oldest = searchCache.keys().next().value;

    if (oldest !== undefined) {
      searchCache.delete(oldest);
    }
  }

  return results;
}

export function __resetSearchCache(): void {
  searchCache.clear();
}
