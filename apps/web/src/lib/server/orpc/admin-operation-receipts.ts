// The operation-receipt control plane: agent-tier read-only inspection/reconciliation and an
// operator-only bounded repair. Bounded coordinates travel in POST bodies; no route logs them.

import { getDb } from "../db";
import { getHealthSnapshotReceiptCutoverDispositionFor } from "../health-receipt-cutover";
import { logEvent } from "../log";
import {
  inspectOperationReceipt,
  reconcileOperationReceipt,
  repairStaleOperationReceipts,
  type OperationReceiptInspection,
} from "../operation-receipts";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { ApiError } from "../spotify";
import { type Implementer, toFault } from "./_shared";

function inspectionSummary(inspection: OperationReceiptInspection) {
  if (inspection.outcome === "not-found") {
    return {
      createdAt: null,
      operationId: null,
      outcome: "not-found" as const,
      resultIdentity: null,
      state: null,
      terminalAt: null,
      updatedAt: null,
    };
  }

  if (inspection.outcome === "lookup-failed") {
    throw new ApiError(
      "operation_receipt_lookup_failed",
      "The operation receipt could not be inspected safely.",
      503,
    );
  }

  return {
    createdAt: inspection.createdAt,
    operationId: inspection.operationId,
    outcome: inspection.state === "accepted" ? ("in-progress" as const) : inspection.state,
    resultIdentity: inspection.resultIdentity,
    state: inspection.state,
    terminalAt: inspection.terminalAt,
    updatedAt: inspection.updatedAt,
  };
}

async function inspectReceipt(operationKey: string) {
  return {
    ok: true as const,
    receipt: inspectionSummary(await inspectOperationReceipt(await getDb(), operationKey)),
  };
}

/** Build the operation-receipt inspection, reconciliation, and repair handlers. */
export function adminOperationReceiptHandlers(os: Implementer) {
  const getOperationReceiptHandler = os.get_operation_receipt
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        return await inspectReceipt(input.operationKey);
      } catch (error) {
        throw toFault(error);
      }
    });

  const resolveOperationReceiptHandler = os.resolve_operation_receipt
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const db = await getDb();
        const inspection = await inspectOperationReceipt(db, input.operationKey);
        if (inspection.outcome === "lookup-failed") {
          throw new ApiError(
            "operation_receipt_lookup_failed",
            "The operation receipt could not be reconciled safely.",
            503,
          );
        }

        if (inspection.outcome === "not-found") {
          if (input.operationId !== "health.snapshot") {
            logEvent("info", "operation-receipt.reconciled", {
              operationId: input.operationId,
              outcome: "not-found",
            });
            return { ok: true as const, receipt: inspectionSummary(inspection) };
          }

          const cutover = await getHealthSnapshotReceiptCutoverDispositionFor(db);
          if (cutover === "unavailable") {
            throw new ApiError(
              "operation_receipt_cutover_unavailable",
              "The operation receipt cutover could not be reconciled safely.",
              503,
            );
          }

          const outcome = cutover === "enabled" ? "safely-retryable" : "cutover-disabled";
          logEvent("info", "operation-receipt.reconciled", {
            operationId: input.operationId,
            outcome,
          });
          return { ok: true as const, receipt: { ...inspectionSummary(inspection), outcome } };
        }

        const reconciliation = await reconcileOperationReceipt({ client: db, ...input });
        if (reconciliation.outcome === "lookup-failed") {
          throw new ApiError(
            "operation_receipt_lookup_failed",
            "The operation receipt could not be reconciled safely.",
            503,
          );
        }

        logEvent("info", "operation-receipt.reconciled", {
          operationId: input.operationId,
          outcome: reconciliation.outcome,
          state: inspection.state,
        });
        return {
          ok: true as const,
          receipt: { ...inspectionSummary(inspection), outcome: reconciliation.outcome },
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
    resolve_operation_receipt: resolveOperationReceiptHandler,
  };
}
