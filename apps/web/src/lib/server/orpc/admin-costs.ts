// The `admin-costs` domain router module — the agent-tier WRITE into the
// append-only `cost_events` ledger (COST-01).
//
//   - `record_cost` — POST /admin/costs/events on `adminAuth` ONLY (no
//     `operatorGuard`): AGENT tier, like `record_health`/`context_track`. The
//     box's sweeps POST a tick's cost rows with the agent token; the handler
//     appends them via `insertCostEvents` (idempotent — ON CONFLICT(id) DO
//     NOTHING) and acks `{ ok, inserted }` (the count actually written, so a
//     retried batch is seen to land zero). Internal write only, fully reversible.
//
// The contract's Zod input has already validated the array shape; the handler
// trusts the types and prices/stamps each row inside `insertCostEvents`.

import { insertCostEvents } from "../costs";
import { adminAuth } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

/** Build the `admin-costs` domain's handlers. */
export function adminCostsHandlers(os: Implementer) {
  // POST /admin/costs/events — agent tier (`adminAuth` only). Idempotent append.
  const recordCostHandler = os.record_cost.use(adminAuth).handler(async ({ input }) => {
    try {
      const inserted = await insertCostEvents(input);

      return { inserted, ok: true as const };
    } catch (error) {
      throw apiFault(error);
    }
  });

  return {
    record_cost: recordCostHandler,
  };
}
