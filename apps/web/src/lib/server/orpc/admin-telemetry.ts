// The `admin-telemetry` domain router module — the run ledger (`run_events`, in the
// second database `fluncle-telemetry`).
//
//   - `record_run` — POST /admin/telemetry/runs on `adminAuth` ONLY (no
//     `operatorGuard`): AGENT tier, the `record_cost` / `record_health` precedent. The
//     box's `emit_cron_output` wrapper POSTs one envelope per sweep tick with the agent
//     token; the handler normalizes it, DERIVES `ok`, and appends via `insertRunEvent`
//     (idempotent — ON CONFLICT(id) DO NOTHING). Internal diagnostics write only.
//   - `read_run_ledger` — GET /admin/telemetry/runs on `adminAuth` + `operatorGuard`:
//     OPERATOR tier. Raw rows plus whole-window per-unit aggregates, with no baked
//     defect verdict.
//
// The contract's Zod input has validated the ENVELOPE (and rejected any unknown key in
// it); everything inside `summary_raw` is validated by `normalizeRunSummary`, which
// throws a 400-carrying `ApiError` for a summary that lies or contradicts itself and
// records — never guesses — the counters a summary simply did not carry.
//
// `toFault` rather than `apiFault`: the 400 must reach the caller as a 400. `apiFault`
// would also do that for an `ApiError`, but `toFault` is the canonical admin catch and
// keeps an `ORPCError` thrown by the auth guard intact as well.

import { insertRunEvent, readRunLedger } from "../run-events";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { type Implementer, toFault } from "./_shared";

/** Build the `admin-telemetry` domain's handlers. */
export function adminTelemetryHandlers(os: Implementer) {
  // GET /admin/telemetry/runs — operator tier. Internal host/sweep evidence.
  const readRunLedgerHandler = os.read_run_ledger
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        return await readRunLedger(input);
      } catch (error) {
        throw toFault(error);
      }
    });

  // POST /admin/telemetry/runs — agent tier (`adminAuth` only). Idempotent append.
  const recordRunHandler = os.record_run.use(adminAuth).handler(async ({ input }) => {
    try {
      const recorded = await insertRunEvent(input);

      return { ...recorded, ok: true as const };
    } catch (error) {
      throw toFault(error);
    }
  });

  return {
    read_run_ledger: readRunLedgerHandler,
    record_run: recordRunHandler,
  };
}
