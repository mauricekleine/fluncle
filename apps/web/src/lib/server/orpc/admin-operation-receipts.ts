// The operation-receipt control plane: agent-tier read-only reconciliation and an
// operator-only bounded repair. Neither route returns request digests or result payloads.

import { getDb } from "../db";
import { getHealthSnapshotReceiptCutoverDispositionFor } from "../health-receipt-cutover";
import { logEvent } from "../log";
import { inspectOperationReceipt, repairStaleOperationReceipts } from "../operation-receipts";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { ApiError } from "../spotify";
import { type Implementer, toFault } from "./_shared";

/** Build the operation-receipt reconciliation and repair handlers. */
export function adminOperationReceiptHandlers(os: Implementer) {
  const getOperationReceiptHandler = os.get_operation_receipt
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const db = await getDb();
        const inspection = await inspectOperationReceipt(db, input.operationKey);

        if (inspection.outcome === "lookup-failed") {
          logEvent("error", "operation-receipt.reconciliation-failed", {
            outcome: inspection.outcome,
          });
          throw new ApiError(
            "operation_receipt_lookup_failed",
            "The operation receipt could not be reconciled safely.",
            503,
          );
        }

        if (inspection.outcome === "not-found") {
          const cutover = await getHealthSnapshotReceiptCutoverDispositionFor(db);
          if (cutover === "unavailable") {
            throw new ApiError(
              "operation_receipt_cutover_unavailable",
              "The operation receipt cutover could not be reconciled safely.",
              503,
            );
          }
          const outcome = cutover === "enabled" ? "safely-retryable" : "cutover-disabled";
          logEvent("info", "operation-receipt.reconciled", { outcome });
          return {
            ok: true as const,
            receipt: {
              createdAt: null,
              operationId: null,
              outcome,
              resultIdentity: null,
              state: null,
              terminalAt: null,
              updatedAt: null,
            },
          };
        }

        const outcome = inspection.state === "accepted" ? "in-progress" : inspection.state;
        logEvent("info", "operation-receipt.reconciled", {
          operationId: inspection.operationId,
          outcome,
          state: inspection.state,
        });
        return {
          ok: true as const,
          receipt: {
            createdAt: inspection.createdAt,
            operationId: inspection.operationId,
            outcome,
            resultIdentity: inspection.resultIdentity,
            state: inspection.state,
            terminalAt: inspection.terminalAt,
            updatedAt: inspection.updatedAt,
          },
        };
      } catch (error) {
        throw toFault(error);
      }
    });

  const reconcileOperationReceiptsHandler = os.reconcile_operation_receipts
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const outcome = await repairStaleOperationReceipts({
          client: await getDb(),
          limit: input.limit,
          staleBefore: new Date(input.staleBefore).toISOString(),
        });
        logEvent("warn", "operation-receipt.stale-repair", outcome);
        return { ...outcome, ok: true as const };
      } catch (error) {
        throw toFault(error);
      }
    });

  return {
    get_operation_receipt: getOperationReceiptHandler,
    reconcile_operation_receipts: reconcileOperationReceiptsHandler,
  };
}
