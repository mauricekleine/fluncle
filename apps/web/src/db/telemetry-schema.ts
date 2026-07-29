// THE RUN LEDGER — the schema of the SECOND database, `fluncle-telemetry`.
//
// One table, `run_events`: one row per host-timer sweep tick, written by the
// agent-tier `record_run` op from the envelope `emit_cron_output` (the shared bash
// wrapper every sweep already goes through) POSTs. It answers an OPS question —
// "did this sweep run, did it do anything, is it blind?" — and joins to nothing.
//
// WHY A SECOND DATABASE. libSQL has a single writer, and this system has a measured
// scar where a timer convoy stalled it. A ledger sitting behind that same writer
// goes dark exactly when the wedge it should be diagnosing happens. `cost_events`
// STAYS in the primary — it joins to `track_id`/`log_id` and answers a PRODUCT
// question; this one is deliberately on the other side of the writer.
//
// This module is the drizzle schema for `drizzle-telemetry.config.ts` and its own
// `./drizzle-telemetry` migrations folder. It is NEVER imported by
// `src/db/schema.ts` and the two never share a migrations folder — a telemetry
// migration must not be able to touch the primary.

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * ONE SWEEP TICK. Modelled on `cost_events` (schema.ts): a deterministic client-side
 * id as the idempotency key, and `occurred_at` (box time) kept DISTINCT from
 * `created_at` (Worker write time).
 *
 * WHAT THIS TABLE EXISTS TO CATCH — every column below was earned by a real, measured
 * defect, not by imagination:
 *
 *   - Seven days of a broken Deezer rung were invisible because
 *     `isrcRecoveredByDeezer: 0` was printed in every tick summary and read by nobody.
 *   - The nightly Sentry sweep exited 0 for ELEVEN nights while printing
 *     `{"errors":2,"ok":true}` — a hardcoded literal sitting beside the number that
 *     contradicted it. Hence `ok` is DERIVED here and a caller-supplied one is REJECTED.
 *   - Several sweeps report a PAGE CAP dressed as a backlog (`queueDepth:24` was
 *     `QUEUE_LIMIT`), so `produced == 0 AND queue_depth > 0` is the alarm CONJUNCTION —
 *     a sweep with a genuinely empty worklist legitimately produces nothing forever.
 *   - A healthy watchdog legitimately produces 0 re-arms forever; only the DENOMINATOR
 *     (`checked`) separates health from blindness. `checked == 0` is a FAILURE for a
 *     detector-class sweep, never a pass.
 *
 * DURABILITY IS DELIBERATELY BEST-EFFORT. A dropped POST leaves a missing row, a missing
 * row looks like a missed run, and the roster alarms on that. Absence being loud is why
 * delivery need not be guaranteed.
 */
export const runEvents = sqliteTable(
  "run_events",
  {
    // The DENOMINATOR — units of work the run LOOKED at. NULL when the summary did not
    // carry it (and the name then appears in `missing_fields`); never guessed to 0,
    // because 0 is a real and DIFFERENT reading: "I looked at nothing", which for a
    // detector-class sweep is the blindness signal itself.
    checked: integer("checked"),
    // ISO Worker write time — DISTINCT from `occurred_at` because a box row's run time
    // precedes its Worker write under clock skew / retry (the `cost_events` precedent).
    createdAt: text("created_at").notNull(),
    // ISO box time the run finished.
    endedAt: text("ended_at").notNull(),
    // The run's own error count, as a VALIDATED integer. An `errors` that arrives as an
    // array/string/null is REJECTED at the contract edge rather than stored as NULL: a
    // real sweep emits `"failed":[]`, which a naive `typeof === "number"` guard drops
    // silently — and a silently-dropped error count is how `ok` lied for eleven nights.
    errors: integer("errors"),
    // The process exit code (0–255). One half of the derived `ok`.
    exitCode: integer("exit_code").notNull(),
    // How often this unit is SUPPOSED to run, so freshness is judged against what
    // actually runs rather than against a hardcoded guess in the reader.
    expectedIntervalMs: integer("expected_interval_ms"),
    // THE THIRD STATE — neither ok nor down. A paused/disabled sweep did not fail; it
    // did not run. NULL means the summary reported no gate at all. Note what is NOT
    // here: a paused run's counters are stored NULL, never 0, because 0 is reserved for
    // "I tried and found nothing" (the `cost_events` posture — a rate-miss surfaces as
    // unpriced, never laundered to $0).
    gateState: text("gate_state", { enum: ["active", "disabled", "paused"] }),
    // The deterministic idempotency key: `${unit}:${startedAt}`, derived by the Worker
    // from the envelope (see lib/server/run-events.ts `runEventId`). Inserted
    // `ON CONFLICT(id) DO NOTHING`, so a retried best-effort POST collapses to ONE row
    // instead of double-counting. A systemd timer cannot start the same unit twice at
    // the same instant, so the pair is unique by construction.
    id: text("id").primaryKey(),
    // JSON array of the MANDATORY summary fields this run did not carry. THE UPGRADE
    // QUEUE: sweeps get improved one at a time, driven by this list. Recorded, never
    // guessed — a field the Worker had to invent is a field nobody can trust.
    missingFields: text("missing_fields").notNull(),
    // ISO box time the run STARTED. The ledger's time axis (every read windows on it).
    occurredAt: text("occurred_at").notNull(),
    // 0/1, DERIVED by the Worker as `exit_code === 0 && (errors ?? 0) === 0` and NEVER
    // accepted from the caller. This is the single most important column in the table:
    // the schema REJECTS a caller-supplied `ok` outright, because the defect that
    // motivated this ledger was a sweep asserting its own health next to the number
    // that disproved it.
    ok: integer("ok").notNull(),
    // Units of work actually WRITTEN this run — not rows visited (that is `checked`).
    // The numerator of the alarm conjunction.
    produced: integer("produced"),
    // The REAL backlog left behind. Only ever populated from a canonical `queueDepth`
    // key: a sweep that prints `queued` / `queueRemaining` gets `queue_depth` listed in
    // `missing_fields` instead, because those have all been measured to be page caps
    // wearing a depth's name, and laundering one into this column would manufacture a
    // healthy-looking backlog out of a pagination constant.
    queueDepth: integer("queue_depth"),
    // ended_at − started_at in ms, derived by the Worker. NULL when either timestamp is
    // not parseable — recorded as unknown rather than as 0.
    runDurationMs: integer("run_duration_ms"),
    // The tick's summary line, verbatim and bounded. Kept even when it did not parse:
    // a sweep that crashed before printing a usable summary is exactly the case this
    // ledger exists to capture, so the unparseable text is evidence, not garbage.
    summaryRaw: text("summary_raw"),
    // WHY the summary yielded what it yielded. Without this, "crashed before printing
    // anything" and "printed a well-formed `{}`" produce an identical `missing_fields`
    // list and are indistinguishable — which is the ambiguity that lets a dead sweep
    // read as a merely-unimproved one.
    summaryStatus: text("summary_status", {
      enum: ["absent", "malformed", "not_object", "parsed"],
    }).notNull(),
    // The systemd unit that ran, e.g. `fluncle-enrich`. Plain TEXT — a NEW sweep is a
    // data row, never a migration (the `platform_stats` / `service_check_samples` idiom).
    unit: text("unit").notNull(),
    // JSON array of summary keys the Worker does not recognise. The other half of the
    // upgrade queue: `missing_fields` says what to ADD, this says what to RENAME. They
    // are recorded rather than silently dropped — an unread number is the whole reason
    // this table exists.
    unrecognisedFields: text("unrecognised_fields").notNull(),
    // RESERVED for v1 — filled opportunistically from sweeps that already emit a
    // vendor-shaped count. Not mandatory, so its absence never enters `missing_fields`.
    vendorCalls: integer("vendor_calls"),
  },
  (table) => [
    // Index the QUERY SHAPE, not every column (the `cost_events` discipline). The reader
    // asks exactly three questions: "latest run per unit" and "runs for unit X over a
    // window" — both served by the composite, left-to-right — and "units with no row in
    // the last N hours", a bare time window served by the second.
    index("run_events_unit_occurred_at_idx").on(table.unit, table.occurredAt),
    index("run_events_occurred_at_idx").on(table.occurredAt),
  ],
);
