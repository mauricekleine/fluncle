import { SENTRY_RELEASE } from "../../sentry-config";
import { probeHealthDatabase } from "../health-database-probe";
import { type Implementer } from "./_shared";

export function healthHandlers(os: Implementer) {
  const getHealth = os.get_health.handler(async ({ errors }) => {
    const database = await probeHealthDatabase();
    const sha = SENTRY_RELEASE ?? null;
    if (database.status === "down") {
      throw errors.SERVICE_UNAVAILABLE({
        data: { database: { ...database, status: "down" }, ok: false, sha },
      });
    }
    return { database: { ...database, status: database.status }, ok: true, sha };
  });

  return { get_health: getHealth };
}
