// The `admin-health` domain router module — the agent-tier WRITE behind the
// public /status dashboard.
//
//   - `record_health` — POST /admin/health on `adminAuth` ONLY (no
//     `operatorGuard`): agent tier, like `context_track`/`note_track`. The box's
//     status cron POSTs one snapshot; the handler persists it via
//     `recordHealthSnapshot` (upsert each `service_status` row + append the
//     transitioned `status_events`, then prune the ledger) and acks `{ ok: true }`.
//
// The contract's Zod input has already validated the shape (an ISO `at` string +
// a `checks` array of `{ service, status, message, latencyMs, transitioned }`),
// so the handler trusts the types and only normalizes the free-text `message`
// (trim + cap) to keep the public page tidy — it never re-derives the snapshot.

import { type InferContractRouterInputs } from "@orpc/contract";
import { type contract } from "@fluncle/contracts/orpc";
import { getHealthSnapshotReceiptCutoverDisposition } from "../health-receipt-cutover";
import { adminAuth } from "../orpc-auth";
import { ApiError } from "../spotify";
import {
  healthSnapshotOperationKey,
  type HealthCheckInput,
  recordHealthSnapshot,
  recordHealthSnapshotWithReceipt,
} from "../status";
import { type Implementer, toFault } from "./_shared";

type RecordHealthInput = InferContractRouterInputs<typeof contract>["record_health"];
type RawCheck = RecordHealthInput["checks"][number];

// Keep a message short + single-line for the public grid; a probe should already
// send something clean, this is the belt-and-braces cap.
const MESSAGE_MAX = 160;

/** Trim, collapse whitespace, and cap a probe message; an empty result is null. */
function cleanMessage(message: string | null): string | null {
  if (message === null) {
    return null;
  }

  const collapsed = message.replace(/\s+/g, " ").trim();

  if (collapsed.length === 0) {
    return null;
  }

  return collapsed.length > MESSAGE_MAX ? `${collapsed.slice(0, MESSAGE_MAX - 1)}…` : collapsed;
}

function normalizeCheck(check: RawCheck): HealthCheckInput {
  return {
    latencyMs: check.latencyMs,
    message: cleanMessage(check.message),
    service: check.service.trim(),
    status: check.status,
    transitioned: check.transitioned,
  };
}

/** Build the `admin-health` domain's handlers. */
export function adminHealthHandlers(os: Implementer) {
  // POST /admin/health — agent tier (`adminAuth` only). Persist one snapshot and
  // ack. Internal write (service_status / status_events); no public lastmod moves.
  const recordHealthHandler = os.record_health.use(adminAuth).handler(async ({ input }) => {
    try {
      const checks = input.checks.map(normalizeCheck);

      if (input.operationKey === undefined) {
        await recordHealthSnapshot(input.at, checks);
        return { ok: true as const };
      }

      const expectedOperationKey = healthSnapshotOperationKey(input.at);
      if (input.operationKey !== expectedOperationKey) {
        throw new ApiError(
          "operation_key_mismatch",
          "The operation key does not identify this health snapshot.",
          409,
        );
      }

      const cutover = await getHealthSnapshotReceiptCutoverDisposition();
      if (cutover === "unavailable") {
        throw new ApiError(
          "operation_receipt_cutover_unavailable",
          "The health snapshot write path could not be selected safely.",
          503,
        );
      }

      if (cutover === "disabled") {
        await recordHealthSnapshot(input.at, checks);
        return { ok: true as const };
      }

      const outcome = await recordHealthSnapshotWithReceipt(input.operationKey, input.at, checks);
      if (outcome.outcome === "committed") {
        return { ok: true as const };
      }

      if (outcome.outcome === "conflict") {
        throw new ApiError(
          "operation_receipt_digest_mismatch",
          "The operation key is already bound to a different health snapshot.",
          409,
        );
      }

      if (outcome.outcome === "in-progress" || outcome.outcome === "rejected") {
        throw new ApiError(
          "operation_receipt_terminal",
          "The operation receipt is not eligible for automatic replay.",
          409,
        );
      }

      throw new ApiError(
        "operation_receipt_unavailable",
        "The operation outcome could not be reconciled safely.",
        503,
      );
    } catch (error) {
      throw toFault(error);
    }
  });

  return {
    record_health: recordHealthHandler,
  };
}
