import { adminAuth, operatorGuard } from "../orpc-auth";
import {
  acknowledgeTursoUsageAlerts,
  getTursoUsageBoard,
  recordTursoUsage,
  setTursoUsageThreshold,
} from "../turso-usage";
import { apiFault, type Implementer } from "./_shared";

export function adminTursoUsageHandlers(os: Implementer) {
  const recordTursoUsageHandler = os.record_turso_usage
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        return { ...(await recordTursoUsage(input)), ok: true } as const;
      } catch (error) {
        throw apiFault(error);
      }
    });

  const getTursoUsageHandler = os.get_turso_usage.use(adminAuth).handler(async () => {
    try {
      return { ...(await getTursoUsageBoard()), ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  const acknowledgeTursoUsageAlertsHandler = os.acknowledge_turso_usage_alerts
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        return {
          acknowledged: await acknowledgeTursoUsageAlerts(input.alerts),
          ok: true,
        } as const;
      } catch (error) {
        throw apiFault(error);
      }
    });

  const setTursoUsageThresholdHandler = os.set_turso_usage_threshold
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        return {
          ok: true,
          thresholdUsd: await setTursoUsageThreshold(input.thresholdUsd),
        } as const;
      } catch (error) {
        throw apiFault(error);
      }
    });

  return {
    acknowledge_turso_usage_alerts: acknowledgeTursoUsageAlertsHandler,
    get_turso_usage: getTursoUsageHandler,
    record_turso_usage: recordTursoUsageHandler,
    set_turso_usage_threshold: setTursoUsageThresholdHandler,
  };
}
