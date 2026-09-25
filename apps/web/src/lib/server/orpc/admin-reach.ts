import { recordPlatformStats } from "../platform-stats";
import { adminAuth } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

export function adminReachHandlers(os: Implementer) {
  const recordPlatformStatsHandler = os.record_platform_stats.use(adminAuth).handler(async () => {
    try {
      const result = await recordPlatformStats();

      return {
        collected: result.collected,
        failed: result.failed,
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
