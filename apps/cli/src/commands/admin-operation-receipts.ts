import { OPERATION_RECEIPT_REPAIR_LIMIT_MAX } from "@fluncle/contracts/orpc";

import { adminApiPost } from "../api";

export type OperationReceiptOutcome =
  | "committed"
  | "conflict"
  | "cutover-disabled"
  | "in-progress"
  | "not-found"
  | "rejected"
  | "safely-retryable";

export type OperationReceiptSummary = {
  createdAt: string | null;
  operationId: string | null;
  outcome: OperationReceiptOutcome;
  resultIdentity: string | null;
  state: "accepted" | "committed" | "rejected" | null;
  terminalAt: string | null;
  updatedAt: string | null;
};

export type OperationReceiptResponse = {
  ok: true;
  receipt: OperationReceiptSummary;
};

export type OperationReceiptRepairResponse = {
  ok: true;
  repaired: number;
  scanned: number;
};

export async function getOperationReceiptCommand(
  operationKey: string,
): Promise<OperationReceiptResponse> {
  return adminApiPost<OperationReceiptResponse>("/api/v1/admin/operation-receipts/inspect", {
    operationKey,
  });
}

export async function repairOperationReceiptsCommand(input: {
  limit: number;
  staleBefore: string;
}): Promise<OperationReceiptRepairResponse> {
  return adminApiPost<OperationReceiptRepairResponse>(
    "/api/v1/admin/operation-receipts/reconcile",
    input,
  );
}

export async function reconcileOperationReceiptCommand(input: {
  operationId: string;
  operationKey: string;
  requestDigest: string;
}): Promise<OperationReceiptResponse> {
  return adminApiPost<OperationReceiptResponse>("/api/v1/admin/operation-receipts/resolve", input);
}

export function parseOperationReceiptRepairLimit(value: string): number {
  const limit = Number(value);

  if (!Number.isSafeInteger(limit) || limit < 1 || limit > OPERATION_RECEIPT_REPAIR_LIMIT_MAX) {
    throw new Error(
      `--limit must be a whole number from 1 through ${OPERATION_RECEIPT_REPAIR_LIMIT_MAX}`,
    );
  }

  return limit;
}

export function parseOperationReceiptFence(value: string): string {
  const time = Date.parse(value);

  if (!Number.isFinite(time) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error("--stale-before must be an ISO timestamp with an explicit offset");
  }

  return new Date(time).toISOString();
}

export function operationReceiptLines(receipt: OperationReceiptSummary): string[] {
  const lines = [`Outcome: ${receipt.outcome}`];

  if (receipt.operationId !== null) {
    lines.push(`Operation: ${receipt.operationId}`);
  }
  if (receipt.state !== null) {
    lines.push(`State: ${receipt.state}`);
  }
  if (receipt.resultIdentity !== null) {
    lines.push(`Result: ${receipt.resultIdentity}`);
  }
  if (receipt.updatedAt !== null) {
    lines.push(`Updated: ${receipt.updatedAt}`);
  }

  return lines;
}
