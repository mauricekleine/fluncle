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
import { type HealthCheckInput, recordHealthSnapshot } from "../status";
import { adminAuth } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

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
      await recordHealthSnapshot(input.at, input.checks.map(normalizeCheck));

      return { ok: true as const };
    } catch (error) {
      throw apiFault(error);
    }
  });

  return {
    record_health: recordHealthHandler,
  };
}
