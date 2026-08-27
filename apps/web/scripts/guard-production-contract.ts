#!/usr/bin/env bun
/**
 * Fail closed before any production deploy can remove the keyed operation-receipt compatibility
 * route ahead of its deployed callers. This guard is deliberately local-only: it reads the
 * checked-out contract and the persistent public caller-floor value without constructing a database
 * client, so both the migration-bearing Cloudflare path and the migration-free manual path can run
 * it before `wrangler deploy`.
 */
import { readFileSync } from "node:fs";

export const OPERATION_RECEIPT_CALLER_FLOOR_ENV = "FLUNCLE_OPERATION_RECEIPT_CALLER_FLOOR";
export const OPERATION_RECEIPT_CALLER_FLOOR_SHA = "a58f9441088728efa03f8745813ac17425229c18";

/** Detect the exact compatibility operation in the checked-out oRPC contract source. */
export function hasLegacyOperationReceiptRoute(contractSource: string): boolean {
  return /^\s*["']?get_operation_receipt_legacy["']?\s*:/m.test(contractSource);
}

/** Require the durable deployed-caller floor only after this checkout removes the legacy route. */
export function requireOperationReceiptCallerFloor(
  contractSource: string,
  callerFloor: string | undefined,
): boolean {
  const legacyRoutePresent = hasLegacyOperationReceiptRoute(contractSource);
  if (legacyRoutePresent) {
    return true;
  }

  if (callerFloor !== OPERATION_RECEIPT_CALLER_FLOOR_SHA) {
    throw new Error(
      `production deploy guard: get_operation_receipt_legacy is absent; ${OPERATION_RECEIPT_CALLER_FLOOR_ENV} must exactly equal the deployed caller floor "${OPERATION_RECEIPT_CALLER_FLOOR_SHA}"`,
    );
  }

  return false;
}

/** Validate the checked-out contract before either production deploy path can do external work. */
export function guardCheckedOutOperationReceiptContract(): boolean {
  const contractSource = readFileSync(
    new URL("../../../packages/contracts/src/orpc/admin-operation-receipts.ts", import.meta.url),
    "utf8",
  );

  return requireOperationReceiptCallerFloor(
    contractSource,
    process.env[OPERATION_RECEIPT_CALLER_FLOOR_ENV],
  );
}

if (import.meta.main) {
  try {
    const legacyRoutePresent = guardCheckedOutOperationReceiptContract();
    console.warn(
      legacyRoutePresent
        ? "PRODUCTION DEPLOY GUARD: clear — get_operation_receipt_legacy remains in this checkout."
        : `PRODUCTION DEPLOY GUARD: caller floor confirmed — ${OPERATION_RECEIPT_CALLER_FLOOR_SHA}.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "production deploy guard failed");
    process.exitCode = 1;
  }
}
