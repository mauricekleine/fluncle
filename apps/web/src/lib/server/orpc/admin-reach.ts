// The `admin-reach` domain router module — the agent-tier WRITE behind the public
// /reach page.
//
//   - `record_platform_stats` — POST /admin/reach/collect on `adminAuth` ONLY (no
//     `operatorGuard`): agent tier, like `record_health`/`record_cost`. The box's
//     reach cron POSTs a bare trigger; the handler runs the collector (every Tier-1
//     platform, each best-effort, Worker-side) and persists the snapshot via
//     `recordPlatformStats`, acking the per-platform outcome + the count inserted.
//
// The op takes no body — the Worker owns every platform credential — so the handler
// simply drives the collector and returns what landed / what was skipped.

import { recordPlatformStats } from "../platform-stats";
import { adminAuth } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

/** Build the `admin-reach` domain's handlers. */
export function adminReachHandlers(os: Implementer) {
  // POST /admin/reach/collect — agent tier (`adminAuth` only). Collect + persist one
  // daily snapshot and ack. Internal write (platform_stats); no public lastmod moves.
  const recordPlatformStatsHandler = os.record_platform_stats.use(adminAuth).handler(async () => {
    try {
      const result = await recordPlatformStats();

      return {
        collected: result.collected,
        inserted: result.inserted,
        ok: true as const,
        skipped: result.skipped,
      };
    } catch (error) {
      throw apiFault(error);
    }
  });

  return {
    record_platform_stats: recordPlatformStatsHandler,
  };
}
