// The `admin-health` domain router module — the agent-tier WRITE behind the
// public /status dashboard.
//
//   - `record_health` — POST /admin/health on `adminAuth` ONLY (no
//     `operatorGuard`): agent tier, like `context_track`/`note_track`. The box's
//     health producers POST one snapshot. Default-off preserves the legacy writer;
//     flag-on requires producer-scoped receipt metadata and commits the snapshot,
//     pruning, and terminal receipt together before acknowledging it.
//
// The contract's Zod input has already validated the shape (an ISO `at` string +
// a `checks` array of `{ service, status, message, latencyMs, transitioned }`),
// The handler canonicalizes the timestamp and check fields before verifying the
// caller's key and digest or persisting any effect.

import { type InferContractRouterInputs } from "@orpc/contract";
import { type Client } from "@libsql/client";
import { type contract } from "@fluncle/contracts/orpc";
import { getDb } from "../db";
import { getHealthSnapshotReceiptCutoverDispositionFor } from "../health-receipt-cutover";
import { adminAuth } from "../orpc-auth";
import { ApiError } from "../spotify";
import {
  healthSnapshotOperationKey,
  healthSnapshotRequestDigest,
  type HealthCheckInput,
  normalizeHealthSnapshot,
  recordHealthSnapshotFor,
  recordHealthSnapshotWithReceiptFor,
} from "../status";
import { type Implementer, toFault } from "./_shared";

type RecordHealthInput = InferContractRouterInputs<typeof contract>["record_health"];
type RawCheck = RecordHealthInput["checks"][number];

function normalizeCheck(check: RawCheck): HealthCheckInput {
  return {
    latencyMs: check.latencyMs,
    message: check.message,
    service: check.service,
    status: check.status,
    transitioned: check.transitioned,
  };
}

/** Execute the handler's cutover decision against an injected real libSQL client. */
export async function recordHealthSnapshotRequestFor(
  db: Client,
  input: RecordHealthInput,
): Promise<void> {
  const snapshot = normalizeHealthSnapshot(input.at, input.checks.map(normalizeCheck));
  const cutover = await getHealthSnapshotReceiptCutoverDispositionFor(db);
  const metadata = [input.operationKey, input.producer, input.requestDigest];
  const metadataCount = metadata.filter((value) => value !== undefined).length;

  if (metadataCount === 0) {
    if (cutover === "enabled") {
      throw new ApiError(
        "operation_receipt_required",
        "Receipt metadata is required for health snapshot writes.",
        400,
      );
    }

    if (cutover === "unavailable") {
      throw new ApiError(
        "operation_receipt_cutover_unavailable",
        "The health snapshot write path could not be selected safely.",
        503,
      );
    }

    await recordHealthSnapshotFor(db, snapshot.at, snapshot.checks);
    return;
  }

  if (
    metadataCount === 1 &&
    input.operationKey !== undefined &&
    input.producer === undefined &&
    input.requestDigest === undefined
  ) {
    if (cutover === "enabled") {
      throw new ApiError(
        "operation_receipt_required",
        "Producer and request digest are required when receipt-backed writes are enabled.",
        400,
      );
    }

    if (cutover === "unavailable") {
      throw new ApiError(
        "operation_receipt_cutover_unavailable",
        "The health snapshot write path could not be selected safely.",
        503,
      );
    }

    await recordHealthSnapshotFor(db, snapshot.at, snapshot.checks);
    return;
  }

  if (
    input.operationKey === undefined ||
    input.producer === undefined ||
    input.requestDigest === undefined
  ) {
    throw new ApiError(
      "operation_receipt_incomplete",
      "Operation key, producer, and request digest are required together.",
      400,
    );
  }

  const expectedOperationKey = healthSnapshotOperationKey(input.producer, snapshot.at);
  if (input.operationKey !== expectedOperationKey) {
    throw new ApiError(
      "operation_key_mismatch",
      "The operation key does not identify this health snapshot.",
      409,
    );
  }

  const expectedRequestDigest = await healthSnapshotRequestDigest(
    input.producer,
    snapshot.at,
    snapshot.checks,
  );
  if (input.requestDigest !== expectedRequestDigest) {
    throw new ApiError(
      "operation_receipt_digest_mismatch",
      "The request digest does not identify this health snapshot.",
      409,
    );
  }

  if (cutover === "unavailable") {
    throw new ApiError(
      "operation_receipt_cutover_unavailable",
      "The health snapshot write path could not be selected safely.",
      503,
    );
  }

  if (cutover === "disabled") {
    await recordHealthSnapshotFor(db, snapshot.at, snapshot.checks);
    return;
  }

  const outcome = await recordHealthSnapshotWithReceiptFor(
    db,
    input.operationKey,
    input.producer,
    snapshot.at,
    snapshot.checks,
  );
  if (outcome.outcome === "committed") {
    return;
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
}

/** Build the `admin-health` domain's handlers. */
export function adminHealthHandlers(os: Implementer) {
  // POST /admin/health — agent tier (`adminAuth` only). Persist one snapshot and
  // ack. Internal write (service_status / status_events); no public lastmod moves.
  const recordHealthHandler = os.record_health.use(adminAuth).handler(async ({ input }) => {
    try {
      await recordHealthSnapshotRequestFor(await getDb(), input);
      return { ok: true as const };
    } catch (error) {
      throw toFault(error);
    }
  });

  return {
    record_health: recordHealthHandler,
  };
}
