import { listPlatformStats } from "../platform-stats";
import { apiFault, type Implementer } from "./_shared";

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
