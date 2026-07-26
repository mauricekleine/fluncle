// The `admin-hub-counts` domain router module — the self-healing backstop under the maintained
// per-entity hub counts (docs/db-scale-backlog Wave 2 keystone 2, slice C).
//
//   - `reconcile_hub_counts` — POST /admin/hub-counts/reconcile on `adminAuth` ONLY (no
//     `operatorGuard`): AGENT tier, like `rank_catalogue` / `record_catalogue_snapshot`. The
//     box's nightly `fluncle-reconcile-hub-counts` cron POSTs a bare trigger; the Worker
//     recomputes truth in SQL and rewrites only the rows that DISAGREED, acking the corrected
//     count per table. It rewrites derived bookkeeping integers and nothing else — it cannot
//     mint a coordinate, write a note, or certify anything — so the agent token drives it.
//
// A non-zero `corrected` is a SIGNAL (a write path is leaking), so the handler passes the numbers
// straight through rather than collapsing them to an ok/not-ok — the sweep logs them and the
// operator audits the log.

import { reconcileHubCounts } from "../hub-counts-reconcile";
import { adminAuth } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

/** Build the `admin-hub-counts` domain's handlers. */
export function adminHubCountsHandlers(os: Implementer) {
  // POST /admin/hub-counts/reconcile — agent tier (`adminAuth` only). Recompute + correct the
  // maintained counters and ack the drift. Internal write (derived counters); no public moves.
  const reconcileHubCountsHandler = os.reconcile_hub_counts.use(adminAuth).handler(async () => {
    try {
      const { albums, artists, labels, tookMs } = await reconcileHubCounts();

      return { albums, artists, labels, ok: true as const, tookMs };
    } catch (error) {
      throw apiFault(error);
    }
  });

  return {
    reconcile_hub_counts: reconcileHubCountsHandler,
  };
}
