import { insertRunEvent, readRunLedger } from "../run-events";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { type Implementer, toFault } from "./_shared";

export function adminTelemetryHandlers(os: Implementer) {
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
