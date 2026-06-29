// The `admin-twitch` domain router module — the agent-tier WRITE behind the
// cross-surface live-set callout.
//
//   - `record_live_state` — POST /admin/twitch/live on `adminAuth` ONLY (no
//     `operatorGuard`): agent tier, exactly like `record_health`. The on-box
//     `fluncle-live` poller POSTs the raw Twitch state each minute; the handler
//     persists it via `setLiveState` (upsert the single `live_state` row + run the
//     off→on / on→off Telegram transition side-effects) and acks `{ ok: true }`.
//
// The contract's Zod input has already validated the shape, so the handler hands the
// body straight to `setLiveState` (the staleness guard + transition detection live
// there). Telegram side-effects are best-effort inside `setLiveState`, so the ack
// reflects the row write, not the callout.

import { setLiveState } from "../live";
import { adminAuth } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

/** Build the `admin-twitch` domain's handlers. */
export function adminTwitchHandlers(os: Implementer) {
  // POST /admin/twitch/live — agent tier (`adminAuth` only). Persist the live state
  // and ack. Internal write (live_state); no public lastmod moves.
  const recordLiveStateHandler = os.record_live_state.use(adminAuth).handler(async ({ input }) => {
    try {
      await setLiveState({
        at: input.at,
        live: input.live,
        startedAt: input.startedAt,
        title: input.title,
      });

      return { ok: true as const };
    } catch (error) {
      throw apiFault(error);
    }
  });

  return {
    record_live_state: recordLiveStateHandler,
  };
}
