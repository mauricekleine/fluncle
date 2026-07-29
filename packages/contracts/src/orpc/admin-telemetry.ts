// The `admin-telemetry` domain contract module — the agent-tier WRITE into the run
// ledger, `run_events`, which lives in the SECOND database (`fluncle-telemetry`).
//
//   - `record_run` — POST /admin/telemetry/runs. Body: ONE envelope per sweep tick,
//     posted by `emit_cron_output` (the shared bash wrapper every host-timer sweep
//     already goes through). Bash stays dumb; the WORKER owns the schema, so no
//     per-sweep code change is required for v1.
//
// AGENT tier (`adminAuth`, NOT `operatorGuard`) — the `record_cost` / `record_health`
// precedent: the box holds the agent token and this writes only an internal diagnostics
// ledger in a database that holds nothing else. Idempotent by a Worker-derived
// deterministic id, so a retried best-effort POST collapses to one row.
//
// WHY THIS OP EXISTS. Seven days of a broken Deezer rung were invisible not for want of
// logs but because `isrcRecoveredByDeezer: 0` was printed in every tick summary and read
// by nobody. A fleet audit then found 13 defects, and eight of them were numbers that
// were emitted, printed, and read by nobody. This ledger is the consumer those numbers
// never had.
//
// This is a PRIVATE admin op: run telemetry is internal ops data, kept off the public
// OpenAPI doc by the `/admin/*` path filter (orpc.ts).

import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * The unit name cap. A systemd unit name is short (`fluncle-enrich`); 128 is far past
 * anything real, so no sweep can grow into it by accident, and it bounds the column an
 * untrusted-ish emitter writes into.
 */
const MAX_UNIT_CHARS = 128;

/**
 * The timestamp cap. An ISO-8601 instant is ~24–32 chars; 64 leaves room for an offset
 * form without letting a broken emitter push arbitrary text into a time column.
 */
const MAX_TIMESTAMP_CHARS = 64;

/**
 * The raw-summary cap. A tick summary is ONE line of JSON — the widest real one measured
 * is a few hundred bytes. 4 KiB is ~10× that, so a genuine summary always fits, while a
 * sweep that dumps a stack trace (or a runaway loop's output) into the field is rejected
 * at the edge instead of writing an unbounded blob behind an agent token.
 *
 * REJECTED, never truncated: a silently-trimmed summary is a summary you cannot trust,
 * and an untrustworthy diagnostic is the exact failure this ledger exists to end.
 */
export const MAX_SUMMARY_RAW_CHARS = 4096;

/**
 * ONE SWEEP TICK, as the bash wrapper knows it.
 *
 * THE KEYS ARE snake_case — the one place in this contract package that is so. This
 * envelope is authored by a POSIX shell function, not by TypeScript: it is assembled
 * from `$?`, `date`, and the unit name in `emit_cron_output`, and snake_case is that
 * emitter's native vocabulary (as it is systemd's). Pinning the wire to the shape the
 * emitter naturally writes keeps the bash side dumb, which is the whole point of the
 * design — the Worker owns the schema so no sweep has to.
 *
 * `z.strictObject` — an UNKNOWN envelope key is REJECTED, never ignored. This is the
 * posture `docs/vector-serving.md` already ratified for the sonar filter: a version skew
 * between the wrapper and the Worker must DEGRADE LOUDLY rather than silently widen into
 * a field nobody validated. A rejected POST leaves a missing row, and a missing row
 * looks like a missed run, which the roster alarms on — so even the failure is visible.
 *
 * NOTE WHAT IS ABSENT: there is no `ok`, and there is no `id`.
 *   - `ok` is DERIVED by the Worker (`exit_code === 0 && (errors ?? 0) === 0`) and a
 *     caller-supplied one is rejected outright — inside `summary_raw` as much as here.
 *     The nightly Sentry sweep exited 0 for ELEVEN nights while printing
 *     `{"errors":2,"ok":true}`: a hardcoded literal sitting beside the number that
 *     contradicted it. A ledger that accepts a self-assessment inherits the lie.
 *   - `id` is derived from `${unit}:${started_at}`, which this envelope already pins, so
 *     the idempotency key is deterministic without the wrapper having to construct one.
 */
export const RunEventInputSchema = z
  .strictObject({
    /** ISO box time the run finished. */
    ended_at: z.string().min(1).max(MAX_TIMESTAMP_CHARS),
    /** The process exit code. Bash `$?` is definitionally 0–255; anything else is a broken emitter. */
    exit_code: z.number().int().min(0).max(255),
    /** ISO box time the run started. Half of the deterministic idempotency key. */
    started_at: z.string().min(1).max(MAX_TIMESTAMP_CHARS),
    /**
     * The tick's summary line, verbatim. NULLISH on purpose: a sweep that crashed before
     * printing anything is exactly the case this ledger must capture, so its absence is a
     * recorded fact (`summary_status: "absent"`), not a validation failure.
     */
    summary_raw: z.string().max(MAX_SUMMARY_RAW_CHARS).nullish(),
    /** The systemd unit that ran, e.g. `fluncle-enrich`. */
    unit: z.string().min(1).max(MAX_UNIT_CHARS),
  })
  .meta({ id: "RunEventInput" });

/** The envelope `emit_cron_output` POSTs, one per sweep tick. */
export type RunEventInput = z.infer<typeof RunEventInputSchema>;

/**
 * `record_run` → `POST /admin/telemetry/runs` (operationId `recordRun`).
 *
 * AGENT tier (`adminAuth`, no `operatorGuard`): the `record_cost` / `record_health`
 * precedent — the box's wrapper POSTs each tick with the agent token, and the op writes
 * only the internal run ledger (no publish, nothing reversible to reverse).
 *
 * The ack deliberately hands back more than a bare `{ ok }`, because a curl against this
 * op is the fastest way to see the Worker's JUDGEMENT of a run rather than the sweep's
 * own claim about it:
 *   - `ok` is the request ACK (the repo-wide convention), NOT the run's health.
 *   - `runOk` is the DERIVED verdict on the run — the number `ok` in the summary was
 *     never allowed to set.
 *   - `missingFields` is that run's contribution to the upgrade queue: the mandatory
 *     counters its summary did not carry, so the operator improving sweeps one at a time
 *     can read the worklist straight off the response.
 *   - `inserted` is 0 on a retry (the id already existed), so a duplicate POST is
 *     visibly a no-op rather than a silent second row.
 *   - `stored` says whether a telemetry database existed at all. Without it,
 *     `inserted: 0` would mean BOTH "this was a retry" and "there is no ledger here",
 *     and an ambiguous diagnostic is the exact failure this whole design exists to end.
 */
export const recordRun = oc
  .route({
    method: "POST",
    operationId: "recordRun",
    path: "/admin/telemetry/runs",
    summary: "Record one sweep run in the telemetry ledger (idempotent per unit + start)",
    tags: ["Admin"],
  })
  .input(RunEventInputSchema)
  .output(
    z.object({
      id: z.string(),
      inserted: z.number(),
      missingFields: z.array(z.string()),
      ok: z.literal(true),
      runOk: z.boolean(),
      stored: z.boolean(),
    }),
  );

/** The `admin-telemetry` domain's ops, merged into the root contract by `./index.ts`. */
export const adminTelemetryContract = {
  record_run: recordRun,
};
