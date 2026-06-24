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
 * AGENT tier (`adminAuth`, no `operatorGuard`): the box's agent-token status cron
 * drives it, the `context_track`/`note_track` precedent. Persists ONE snapshot:
 * each check upserts its `service_status` row (carrying `since` forward while the
 * status is unchanged, resetting it on a flip), every `transitioned` check appends
 * a `status_events` row, then the ledger is pruned to its most recent 200 rows.
 * Internal write only (no public lastmod moves). Returns the bare `{ ok: true }`.
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
    z.object({
      at: z.string().min(1),
      checks: z.array(HealthCheckSchema),
    }),
  )
  .output(z.object({ ok: z.literal(true) }));

/** The `admin-health` domain's ops, merged into the root contract by `./index.ts`. */
export const adminHealthContract = {
  record_health: recordHealth,
};
