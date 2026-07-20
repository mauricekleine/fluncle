// The `health` domain router module. Implements the health contract ops off the
// shared implementer the root (../orpc.ts) hands in. A future wave adds an op
// here and one spread line in the root — no other domain's file is touched.

import { SENTRY_RELEASE } from "../../sentry-config";
import { type Implementer } from "./_shared";

/**
 * Build the `health` domain's handlers. `get_health` is a direct port of the
 * live /api/health GET, plus the deployed commit `sha`. The live route sets a
 * `Cache-Control: no-store` header; oRPC owns the response framing, so that
 * header is reapplied at the rails mount (../orpc.ts) rather than here.
 *
 * `sha` reuses `SENTRY_RELEASE` — the ONE build-time commit-SHA constant (inlined
 * by vite's `define`, sourced from `WORKERS_CI_COMMIT_SHA` on Cloudflare Workers
 * Builds, else `git rev-parse HEAD`). Sharing that constant is deliberate: health
 * and Sentry's release can never disagree about which build is live. It degrades
 * to `null` when no SHA was resolvable (a shallow checkout with no git and no CI
 * var) — an honest absence, never a wrong value.
 */
export function healthHandlers(os: Implementer) {
  const getHealth = os.get_health.handler(() => ({ ok: true, sha: SENTRY_RELEASE ?? null }));

  return { get_health: getHealth };
}
