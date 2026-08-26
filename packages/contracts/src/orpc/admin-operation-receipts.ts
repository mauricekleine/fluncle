import { oc } from "@orpc/contract";
import * as z from "zod";

export const OPERATION_RECEIPT_KEY_MAX = 256;
export const OPERATION_RECEIPT_REPAIR_LIMIT_MAX = 100;
export const OPERATION_RECEIPT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~:/-]*$/;
export const OPERATION_RECEIPT_REQUEST_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export const OperationReceiptStateSchema = z
  .enum(["accepted", "committed", "rejected"])
  .meta({ id: "OperationReceiptState" });

export const OperationReceiptReconciliationOutcomeSchema = z
  .enum([
    "committed",
    "conflict",
    "cutover-disabled",
    "in-progress",
    "not-found",
    "rejected",
    "safely-retryable",
  ])
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
    method: "POST",
    operationId: "getOperationReceipt",
    path: "/admin/operation-receipts/inspect",
    summary: "Inspect one operation receipt",
    tags: ["Admin"],
  })
  .input(
    z.object({
      operationKey: z
        .string()
        .min(1)
        .max(OPERATION_RECEIPT_KEY_MAX)
        .regex(OPERATION_RECEIPT_KEY_PATTERN),
    }),
  )
  .output(z.object({ ok: z.literal(true), receipt: OperationReceiptSummarySchema }));

/** Initialization-era inspection route retained until Goal H contraction. */
export const getOperationReceiptLegacy = oc
  .route({
    method: "GET",
    operationId: "getOperationReceiptLegacy",
    path: "/admin/operation-receipts/{operationKey}",
    summary: "Inspect one operation receipt through the compatibility route",
    tags: ["Admin"],
  })
  .input(
    z.object({
      operationKey: z.string().min(1).max(OPERATION_RECEIPT_KEY_MAX),
    }),
  )
  .output(z.object({ ok: z.literal(true), receipt: OperationReceiptSummarySchema }));

/** Digest-bound read-only reconciliation. The bounded coordinates travel in a POST body. */
export const resolveOperationReceipt = oc
  .route({
    method: "POST",
    operationId: "resolveOperationReceipt",
    path: "/admin/operation-receipts/resolve",
    summary: "Reconcile one digest-bound operation receipt",
    tags: ["Admin"],
  })
  .input(
    z.object({
      operationId: z
        .string()
        .max(64)
        .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/),
      operationKey: z
        .string()
        .min(1)
        .max(OPERATION_RECEIPT_KEY_MAX)
        .regex(OPERATION_RECEIPT_KEY_PATTERN),
      requestDigest: z.string().regex(OPERATION_RECEIPT_REQUEST_DIGEST_PATTERN),
    }),
  )
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
  get_operation_receipt_legacy: getOperationReceiptLegacy,
  reconcile_operation_receipts: reconcileOperationReceipts,
  resolve_operation_receipt: resolveOperationReceipt,
};
