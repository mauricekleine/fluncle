// The `admin-frontier` domain router module — the weekly Frontier refresh (E2). ONE
// op, ADMIN tier (adminAuth only, no operatorGuard): the box's `fluncle-frontier-
// refresh` cron drives it with the agent-scoped token, the `advance_publish_queue` /
// `rank_catalogue` precedent. It touches only playlists their owners already minted, so
// it creates no new public authority; the Worker owns the Spotify grant, the box only
// triggers.

import { adminAuth, operatorGuard } from "../orpc-auth";
import {
  isFrontierMintingOpen,
  refreshAllFrontierPlaylists,
  setFrontierMintingOpen,
} from "../frontier-playlist";
import { type Implementer, toFault } from "./_shared";

/** How many minted playlists a single refresh tick walks when the caller names no limit. */
const DEFAULT_REFRESH_LIMIT = 500;

/** How many owing covers a single backfill tick renders when the caller names no limit. */
const DEFAULT_COVER_LIMIT = 50;

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

  // The kill switch's read — agent-allowed, the `get_capture_budget` precedent.
  const getMinting = os.get_frontier_minting.use(adminAuth).handler(async () => {
    try {
      return { ok: true as const, open: await isFrontierMintingOpen() };
    } catch (error) {
      throw toFault(error);
    }
  });

  // The kill switch itself — OPERATOR only (`set_capture_budget` reasoning: opening
  // minting grants the machine authority over the operator's own Spotify account, a
  // dial an agent token must never turn).
  const setMinting = os.set_frontier_minting
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        await setFrontierMintingOpen(input.open);

        return { ok: true as const, open: await isFrontierMintingOpen() };
      } catch (error) {
        throw toFault(error);
      }
    });

  // The mint-cover retry drain — admin tier (agent-allowed), the refresh precedent. Renders +
  // uploads every cover still owing IN THE WORKER (Satori → JPEG). The lazy import keeps
  // `workers-og` out of the `./orpc` module graph (the mixtape-cover precedent).
  const uploadCovers = os.upload_frontier_covers.use(adminAuth).handler(async ({ input }) => {
    try {
      const { uploadFrontierCovers } = await import("../frontier-cover");

      return await uploadFrontierCovers(input.limit ?? DEFAULT_COVER_LIMIT);
    } catch (error) {
      throw toFault(error);
    }
  });

  return {
    get_frontier_minting: getMinting,
    refresh_frontier_playlists: refresh,
    set_frontier_minting: setMinting,
    upload_frontier_covers: uploadCovers,
  };
}
