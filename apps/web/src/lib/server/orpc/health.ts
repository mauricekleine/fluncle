import { SENTRY_RELEASE } from "../../sentry-config";
import { type Implementer } from "./_shared";

export function healthHandlers(os: Implementer) {
  const getHealth = os.get_health.handler(() => ({ ok: true, sha: SENTRY_RELEASE ?? null }));

  return { get_health: getHealth };
}
