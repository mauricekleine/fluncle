import { databaseOperationStatement, getDb } from "./db";
import { logEvent } from "./log";

export const HEALTH_DATABASE_BUDGET_MS = 2_500;
export const HEALTH_DATABASE_DEGRADED_QUEUE_MS = 500;
export const HEALTH_DATABASE_DEGRADED_LATENCY_MS = 1_000;

export type HealthDatabaseProbe = {
  latencyMs: number;
  queueWaitMs: number | null;
  status: "ok" | "degraded" | "down";
};

export async function probeHealthDatabase(): Promise<HealthDatabaseProbe> {
  const startedAt = Date.now();
  const controller = new AbortController();
  let queueWaitMs: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Database health probe timed out");
      controller.abort(error);
      reject(error);
    }, HEALTH_DATABASE_BUDGET_MS);
  });
  const query = async () => {
    const db = await getDb();
    controller.signal.throwIfAborted();
    await db.execute(
      databaseOperationStatement("select 1", {
        admissionSignal: controller.signal,
        onAdmission: (waitMs) => {
          queueWaitMs = waitMs;
        },
        operationId: "health.database.probe",
      }),
    );
  };

  try {
    await Promise.race([query(), deadline]);
    const latencyMs = Math.max(0, Date.now() - startedAt);
    if (latencyMs >= HEALTH_DATABASE_BUDGET_MS) {
      controller.abort(new Error("Database health probe timed out"));
      throw controller.signal.reason;
    }
    return {
      latencyMs,
      queueWaitMs,
      status:
        latencyMs >= HEALTH_DATABASE_DEGRADED_LATENCY_MS ||
        (queueWaitMs !== null && queueWaitMs >= HEALTH_DATABASE_DEGRADED_QUEUE_MS)
          ? "degraded"
          : "ok",
    };
  } catch (error) {
    const latencyMs = Math.max(0, Date.now() - startedAt);
    logEvent("warn", "health.database-probe-failed", {
      error,
      latencyMs,
      queueWaitMs,
      timedOut: controller.signal.aborted,
    });
    return { latencyMs, queueWaitMs, status: "down" };
  } finally {
    clearTimeout(timer);
  }
}
