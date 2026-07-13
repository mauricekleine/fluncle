// The `reach` domain router module — the PUBLIC read behind the /reach page. The
// read half of the `record_health` noun-swap (its write is `admin-reach`).
//
//   - `list_platform_stats` — GET /reach/stats, no auth (a public read; every number
//     is already public on its own platform). `windowDays` is a tolerant optional
//     query string parsed + clamped in `listPlatformStats`; the handler passes it
//     through. A public route attaches `.handler` directly (no middleware), like
//     `get_health`.

import { listPlatformStats } from "../platform-stats";
import { apiFault, type Implementer } from "./_shared";

/** Build the `reach` domain's handlers. */
export function reachHandlers(os: Implementer) {
  const listPlatformStatsHandler = os.list_platform_stats.handler(async ({ input }) => {
    try {
      const parsed = input.windowDays ? Number.parseInt(input.windowDays, 10) : undefined;
      const windowDays = parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;

      return await listPlatformStats(windowDays);
    } catch (error) {
      throw apiFault(error);
    }
  });

  return { list_platform_stats: listPlatformStatsHandler };
}
