import { oc } from "@orpc/contract";
import * as z from "zod";

export const OPERATION_RECEIPT_KEY_MAX = 256;
export const OPERATION_RECEIPT_REPAIR_LIMIT_MAX = 100;

export const OperationReceiptStateSchema = z
  .enum(["accepted", "committed", "rejected"])
  .meta({ id: "OperationReceiptState" });

export const OperationReceiptReconciliationOutcomeSchema = z
  .enum(["committed", "cutover-disabled", "in-progress", "rejected", "safely-retryable"])
  .meta({ id: "OperationReceiptReconciliationOutcome" });

const OperationReceiptSummarySchema = z
  .object({
    createdAt: z.string().nullable(),
    operationId: z.string().max(64).nullable(),
    outcome: OperationReceiptReconciliationOutcomeSchema,
    resultIdentity: z.string().max(512).nullable(),
    state: OperationReceiptStateSchema.nullable(),
    terminalAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
  })
  .meta({ id: "OperationReceiptSummary" });

/** Read one receipt outcome without returning its request digest or stored result payload. */
export const getOperationReceipt = oc
  .route({
    method: "GET",
    operationId: "getOperationReceipt",
    path: "/admin/operation-receipts/{operationKey}",
    summary: "Reconcile one operation key against its terminal receipt",
    tags: ["Admin"],
  })
  .input(z.object({ operationKey: z.string().min(1).max(OPERATION_RECEIPT_KEY_MAX) }))
  .output(z.object({ ok: z.literal(true), receipt: OperationReceiptSummarySchema }));

/** Reject a bounded page of accepted receipts that are strictly older than the supplied fence. */
export const reconcileOperationReceipts = oc
  .route({
    method: "POST",
    operationId: "reconcileOperationReceipts",
    path: "/admin/operation-receipts/reconcile",
    summary: "Reject a bounded page of stale in-progress operation receipts",
    tags: ["Admin"],
  })
  .input(
    z.object({
      limit: z.number().int().min(1).max(OPERATION_RECEIPT_REPAIR_LIMIT_MAX),
      staleBefore: z.string().datetime({ offset: true }),
    }),
  )
  .output(
    z.object({
      ok: z.literal(true),
      repaired: z.number().int().min(0).max(OPERATION_RECEIPT_REPAIR_LIMIT_MAX),
      scanned: z.number().int().min(0).max(OPERATION_RECEIPT_REPAIR_LIMIT_MAX),
    }),
  );

export const adminOperationReceiptsContract = {
  get_operation_receipt: getOperationReceipt,
  reconcile_operation_receipts: reconcileOperationReceipts,
};
