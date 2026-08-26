// The `admin-health` domain contract module — the agent-tier WRITE that feeds the
// public service-health status dashboard (/status). A Hermes cron probes the
// services on the box and POSTs ONE snapshot here; the page reads what this op
// persisted.
//
//   - `record_health` — AGENT tier (`adminAuth`, NOT `operatorGuard`): the box's
//     agent token drives the cron, exactly like `context_track`/`note_track`. It
//     writes the internal `service_status` / `status_events` tables only — no
//     publish, fully reversible — so an operator token is not required.
//
// The body is the full snapshot: a wall-clock `at` (ISO) and one `checks` entry
// per probed service. `status` is the three-state health enum; `message`/
// `latencyMs` are nullable; `transitioned` flags the checks whose status flipped
// since the last snapshot (those, and only those, append a `status_events` row).
// The output is the bare `{ ok: true }` ack — the cron only needs the write to
// have landed.

import { oc } from "@orpc/contract";
import * as z from "zod";
import {
  OPERATION_RECEIPT_KEY_MAX,
  OPERATION_RECEIPT_KEY_PATTERN,
  OPERATION_RECEIPT_REQUEST_DIGEST_PATTERN,
} from "./admin-operation-receipts.js";

export const HEALTH_SNAPSHOT_PRODUCER_MAX = 64;
export const HEALTH_SNAPSHOT_PRODUCER_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

/** The three-state service health enum, shared by the snapshot + the stored rows. */
export const ServiceHealthStatusSchema = z
  .enum(["ok", "degraded", "down"])
  .meta({ id: "ServiceHealthStatus" });

/** One probed service in a health snapshot. */
const HealthCheckSchema = z
  .object({
    // Round-trip latency of the probe in ms, or null when not measured.
    latencyMs: z.number().int().nullable(),
    // A short, public-safe human message (never an internal address / raw error).
    message: z.string().nullable(),
    // The probed service name (web/db/r2/dns/ssh/onion/hermes/render-box, …).
    service: z.string().min(1),
    status: ServiceHealthStatusSchema,
    // `true` when this check's status FLIPPED since the last snapshot — the probe
    // computes the transition, and only a transition appends a `status_events` row.
    transitioned: z.boolean(),
  })
  .meta({ id: "HealthCheck" });

/**
 * `record_health` → `POST /admin/health` (operationId `recordHealth`).
 *
 * AGENT tier (`adminAuth`, no `operatorGuard`): the recurring health producers
 * drive it with agent tokens. Persists ONE snapshot:
 * each check upserts its `service_status` row (carrying `since` forward while the
 * status is unchanged, resetting it on a flip), every `transitioned` check appends
 * a `status_events` row, then the ledgers are pruned. Receipt metadata is optional
 * at the contract boundary for default-off compatibility and required by the
 * handler when cutover is enabled. Internal write only (no public lastmod moves).
 */
export const recordHealth = oc
  .route({
    method: "POST",
    operationId: "recordHealth",
    path: "/admin/health",
    summary: "Record a service-health snapshot for the public status dashboard",
    tags: ["Admin"],
  })
  .input(
    z
      .object({
        at: z.string().max(64).datetime({ offset: true }),
        checks: z.array(HealthCheckSchema),
        operationKey: z
          .string()
          .min(1)
          .max(OPERATION_RECEIPT_KEY_MAX)
          .regex(OPERATION_RECEIPT_KEY_PATTERN)
          .optional(),
        producer: z
          .string()
          .max(HEALTH_SNAPSHOT_PRODUCER_MAX)
          .regex(HEALTH_SNAPSHOT_PRODUCER_PATTERN)
          .optional(),
        requestDigest: z.string().regex(OPERATION_RECEIPT_REQUEST_DIGEST_PATTERN).optional(),
      })
      .refine((input) => {
        const values = [input.operationKey, input.producer, input.requestDigest];
        const supplied = values.filter((value) => value !== undefined).length;

        return (
          supplied === 0 ||
          supplied === values.length ||
          (supplied === 1 && input.operationKey !== undefined)
        );
      }, "supply no receipt metadata, the compatibility operationKey, or all receipt fields"),
  )
  .output(z.object({ ok: z.literal(true) }));

/** The `admin-health` domain's ops, merged into the root contract by `./index.ts`. */
export const adminHealthContract = {
  record_health: recordHealth,
};
