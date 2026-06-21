// The `health` domain router module. Implements the health contract ops off the
// shared implementer the root (../orpc.ts) hands in. A future wave adds an op
// here and one spread line in the root — no other domain's file is touched.

import { type Implementer } from "./_shared";

/**
 * Build the `health` domain's handlers. `get_health` is a direct port of the
 * live /api/health GET: the bare `{ ok: true }` envelope. The live route sets a
 * `Cache-Control: no-store` header; oRPC owns the response framing, so that
 * header is reapplied at the rails mount (../orpc.ts) rather than here.
 */
export function healthHandlers(os: Implementer) {
  const getHealth = os.get_health.handler(() => ({ ok: true }) as const);

  return { get_health: getHealth };
}
