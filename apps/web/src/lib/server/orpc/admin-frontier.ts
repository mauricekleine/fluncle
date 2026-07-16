// The `admin-frontier` domain router module — the weekly Frontier refresh (E2). ONE
// op, ADMIN tier (adminAuth only, no operatorGuard): the box's `fluncle-frontier-
// refresh` cron drives it with the agent-scoped token, the `advance_publish_queue` /
// `rank_catalogue` precedent. It touches only playlists their owners already minted, so
// it creates no new public authority; the Worker owns the Spotify grant, the box only
// triggers.

import { adminAuth } from "../orpc-auth";
import { refreshAllFrontierPlaylists } from "../frontier-playlist";
import { type Implementer, toFault } from "./_shared";

/** How many minted playlists a single refresh tick walks when the caller names no limit. */
const DEFAULT_REFRESH_LIMIT = 500;

/**
 * Build the `admin-frontier` domain's handler.
 *
 *   - `refresh_frontier_playlists` — walk up to `limit` minted playlists and re-mirror
 *     each from its owner's current recommendations. Respects the DEFAULT-DENY kill
 *     switch first (closed ⇒ `switchOff: true`, nothing touched). Best-effort per user.
 */
export function adminFrontierHandlers(os: Implementer) {
  const refresh = os.refresh_frontier_playlists.use(adminAuth).handler(async ({ input }) => {
    try {
      return await refreshAllFrontierPlaylists(input.limit ?? DEFAULT_REFRESH_LIMIT);
    } catch (error) {
      throw toFault(error);
    }
  });

  return {
    refresh_frontier_playlists: refresh,
  };
}
