// THE RUN LEDGER's server half — the normalization + the idempotent append into
// `run_events`, the one table of the SECOND database (`fluncle-telemetry`).
//
// Three seams live here, mirroring `costs.ts`:
//
//   - `normalizeRunSummary(summaryRaw)` — the pure parse/validate/derive step. It is
//     where every rule the design earned actually lives, and it is pure so a test can
//     exercise all of them without a database.
//   - `runEventId({ startedAt, unit })` — the deterministic idempotency key.
//   - `insertRunEvent(input)` — the idempotent APPEND
//     (`insert … on conflict(id) do nothing`), returning what was actually written.
//
// WHAT THE RULES ARE FOR — each one was earned by a measured defect, not imagined:
//
//   1. `ok` IS DERIVED, NEVER ACCEPTED. `exit_code === 0 && (errors ?? 0) === 0`. The
//      nightly Sentry sweep exited 0 for ELEVEN nights while printing
//      `{"errors":2,"ok":true}` — a hardcoded literal sitting beside the number that
//      contradicted it. A summary that carries `ok` at all is REJECTED, so the emitter
//      is forced to stop asserting its own health rather than merely being overruled.
//   2. `errors` IS TYPE-VALIDATED. A real sweep emits `"failed":[]`; a naive
//      `typeof === "number"` guard drops an array/string/null SILENTLY, storing NULL and
//      letting `ok` fall back to the exit code alone. So a present-but-wrong-typed
//      counter is a 400, not a shrug.
//   3. MISSING FIELDS ARE RECORDED, NOT GUESSED. The mandatory counters a summary did
//      not carry are listed in `missing_fields`, and THAT LIST IS THE UPGRADE QUEUE.
//      A counter the Worker invented is a counter nobody can trust.
//   4. NO ALIASING A PAGE CAP INTO A DEPTH. `queueDepth:24` was measured to be
//      `QUEUE_LIMIT`; `queued:50` and `queueRemaining:200` are the same illusion. Only
//      the canonical spellings feed `queue_depth`; `queued`/`queueRemaining` land in
//      `unrecognised_fields` and `queue_depth` goes on the upgrade queue, which is
//      exactly the outcome that gets the sweep fixed instead of papered over.
//   5. A GATED RUN'S WORK COUNTERS ARE NULL, NEVER 0. `0` means "I tried and found
//      nothing"; a paused sweep did not try. Laundering it to 0 would fire the
//      `produced == 0 AND queue_depth > 0` alarm on a sweep that is merely switched off
//      — the `cost_events` posture ("a rate-miss surfaces as unpriced, never $0").
//
// Nothing here is best-effort-swallowing: a validation failure is a 400 the wrapper
// ignores, and a database failure is a 500. Both leave the row missing, and a missing
// row looks like a missed run, which the roster alarms on. Absence being loud is
// precisely why delivery does not have to be guaranteed.

import { type RunEventInput } from "@fluncle/contracts/orpc";
import { getTelemetryDb } from "./db";
import { logEvent } from "./log";
import { ApiError } from "./spotify";

/** The closed gate vocabulary, mirroring the `run_events.gate_state` enum. */
export type RunGateState = "active" | "disabled" | "paused";

/** Why the summary yielded what it yielded — mirrors `run_events.summary_status`. */
export type RunSummaryStatus = "absent" | "malformed" | "not_object" | "parsed";

/**
 * THE UPGRADE QUEUE's vocabulary — the mandatory counters, named as the ledger's own
 * columns. A run whose summary omits one gets that name in `missing_fields`, and the
 * operator improves sweeps one at a time by reading the list.
 *
 * `vendor_calls` is deliberately NOT here: v1 keeps it a RESERVED nullable column filled
 * opportunistically from sweeps that already emit a vendor-shaped count, so its absence
 * is not a defect and must not pad every row's worklist. Nor is `gate_state`: most
 * sweeps have no kill switch, and demanding one would file a fake item against every
 * sweep that legitimately has nothing to report.
 */
export const MANDATORY_SUMMARY_FIELDS = [
  "checked",
  "errors",
  "expected_interval_ms",
  "produced",
  "queue_depth",
] as const;

/**
 * The WORK counters — the ones a gated run must report as NULL rather than 0 (rule 5).
 * `errors` is pointedly not among them: it is a FAILURE signal, not a work volume, and
 * suppressing it under a gate would launder a real failure — the same crime in the
 * opposite direction.
 */
const GATE_SUPPRESSED_FIELDS = new Set<string>(["checked", "produced", "queue_depth"]);

/**
 * The recognised counters and the spellings that reach each one. Two spellings are
 * allowed for the compound names because the emitters are a mix of bash (snake_case, its
 * native vocabulary) and the repo's JS sweeps (camelCase) — the SAME semantic under two
 * skins, which is not laundering. What is NOT here is any near-synonym: `queued`,
 * `queueRemaining`, `remaining` all mean something measurably different from a backlog
 * and must never silently become one (rule 4).
 *
 * Both spellings present at once is REJECTED rather than resolved by precedence: a
 * summary that says `queueDepth: 5` and `queue_depth: 9` is a contradiction, and a
 * ledger built to catch contradictions cannot start by quietly picking a winner.
 */
const COUNTER_FIELDS: { canonical: string; spellings: string[] }[] = [
  { canonical: "checked", spellings: ["checked"] },
  { canonical: "errors", spellings: ["errors"] },
  { canonical: "expected_interval_ms", spellings: ["expectedIntervalMs", "expected_interval_ms"] },
  { canonical: "produced", spellings: ["produced"] },
  { canonical: "queue_depth", spellings: ["queueDepth", "queue_depth"] },
  { canonical: "vendor_calls", spellings: ["vendorCalls", "vendor_calls"] },
];

const GATE_STATE_SPELLINGS = ["gateState", "gate_state"];
const PAUSED_SPELLINGS = ["paused"];
const GATE_STATES = new Set<string>(["active", "disabled", "paused"]);

/** Every summary key the Worker recognises — anything else is `unrecognised_fields`. */
const RECOGNISED_KEYS = new Set<string>([
  ...COUNTER_FIELDS.flatMap((field) => field.spellings),
  ...GATE_STATE_SPELLINGS,
  ...PAUSED_SPELLINGS,
]);

/**
 * How many unrecognised key names one row records. The raw summary is capped at 4 KiB
 * by the contract, so the count is already bounded; this keeps the stored JSON array
 * small and readable. Overflow is reported as a trailing `+N more` rather than dropped,
 * because a silently-shortened list is the failure mode this whole file is against.
 */
const MAX_UNRECOGNISED_FIELDS = 32;

/** Each recorded key name is truncated to this, so one absurd key can't dominate the row. */
const MAX_FIELD_NAME_CHARS = 64;

/** The normalized facts a summary yields — the column values, all of them nullable. */
export type NormalizedRunSummary = {
  checked: null | number;
  errors: null | number;
  expectedIntervalMs: null | number;
  gateState: null | RunGateState;
  missingFields: string[];
  produced: null | number;
  queueDepth: null | number;
  summaryStatus: RunSummaryStatus;
  unrecognisedFields: string[];
  vendorCalls: null | number;
};

function reject(message: string): never {
  throw new ApiError("invalid_run_summary", message, 400);
}

/**
 * A counter must be a finite, non-negative INTEGER. Rule 2: a present-but-wrong-typed
 * counter is a 400, never a silent NULL — `"failed": []` is the shape that taught this.
 */
function requireCount(field: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    reject(
      `run summary field "${field}" must be a non-negative integer, got ${JSON.stringify(value)}`,
    );
  }

  return value;
}

/** The one spelling of a field this summary used, or `undefined` when it used none. */
function singleSpelling(
  summary: Record<string, unknown>,
  canonical: string,
  spellings: string[],
): string | undefined {
  const present = spellings.filter((spelling) => Object.hasOwn(summary, spelling));

  if (present.length > 1) {
    reject(
      `run summary carries "${canonical}" under more than one spelling (${present.join(", ")}) — send exactly one`,
    );
  }

  return present[0];
}

/** The gate, from either `paused` (boolean) or `gateState` (the closed enum). */
function readGateState(summary: Record<string, unknown>): null | RunGateState {
  const gateKey = singleSpelling(summary, "gate_state", GATE_STATE_SPELLINGS);
  const pausedKey = singleSpelling(summary, "paused", PAUSED_SPELLINGS);

  if (gateKey !== undefined && pausedKey !== undefined) {
    // One gate signal per summary. Two can disagree, and a ledger that exists to catch
    // a self-contradicting summary cannot begin by reconciling one.
    reject(
      `run summary carries both "${gateKey}" and "${pausedKey}" — send exactly one gate signal`,
    );
  }

  if (gateKey !== undefined) {
    const value = summary[gateKey];

    if (typeof value !== "string" || !GATE_STATES.has(value)) {
      reject(
        `run summary field "${gateKey}" must be one of active/disabled/paused, got ${JSON.stringify(value)}`,
      );
    }

    return value as RunGateState;
  }

  if (pausedKey !== undefined) {
    const value = summary[pausedKey];

    if (typeof value !== "boolean") {
      reject(`run summary field "${pausedKey}" must be a boolean, got ${JSON.stringify(value)}`);
    }

    return value ? "paused" : "active";
  }

  return null;
}

function truncateName(name: string): string {
  return name.length > MAX_FIELD_NAME_CHARS ? `${name.slice(0, MAX_FIELD_NAME_CHARS - 1)}…` : name;
}

/** The unrecognised keys, sorted, bounded, with the overflow COUNTED rather than dropped. */
function collectUnrecognised(summary: Record<string, unknown>): string[] {
  const unknown = Object.keys(summary)
    .filter((key) => !RECOGNISED_KEYS.has(key))
    .sort()
    .map(truncateName);

  if (unknown.length <= MAX_UNRECOGNISED_FIELDS) {
    return unknown;
  }

  return [
    ...unknown.slice(0, MAX_UNRECOGNISED_FIELDS),
    `+${unknown.length - MAX_UNRECOGNISED_FIELDS} more`,
  ];
}

/** A summary that yielded nothing — every counter unknown, every mandatory field owing. */
function emptySummary(summaryStatus: RunSummaryStatus): NormalizedRunSummary {
  return {
    checked: null,
    errors: null,
    expectedIntervalMs: null,
    gateState: null,
    missingFields: [...MANDATORY_SUMMARY_FIELDS],
    produced: null,
    queueDepth: null,
    summaryStatus,
    unrecognisedFields: [],
    vendorCalls: null,
  };
}

/**
 * Parse and validate one tick's summary line into column values.
 *
 * ROBUST BY DESIGN to a summary that is absent, empty, not JSON, or JSON that is not an
 * object: each of those is a RECORDED `summary_status`, never a throw. A sweep that
 * crashed before printing anything is exactly the case the ledger must capture — choking
 * on it would blind the ledger precisely where the failure is worst.
 *
 * It DOES throw (a 400) for a summary that is well-formed but LIES or CONTRADICTS: a
 * self-asserted `ok`, a wrong-typed counter, a field sent under two spellings, two gate
 * signals. Those are emitter bugs the ledger must not absorb.
 */
export function normalizeRunSummary(summaryRaw: null | string | undefined): NormalizedRunSummary {
  const trimmed = summaryRaw?.trim();

  if (!trimmed) {
    return emptySummary("absent");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return emptySummary("malformed");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return emptySummary("not_object");
  }

  const summary = parsed as Record<string, unknown>;

  // Rule 1, first and hardest: the emitter does not get to grade itself.
  if (Object.hasOwn(summary, "ok")) {
    reject('run summary must not carry "ok" — the ledger derives it from exit_code and errors');
  }

  const gateState = readGateState(summary);
  // A gated sweep did not run, so it owes no work counters and must not report 0 for
  // them (rule 5). `errors` and `expected_interval_ms` stay owing: one is a failure
  // signal, the other describes the schedule rather than the run.
  const gated = gateState === "paused" || gateState === "disabled";

  const values = new Map<string, null | number>();
  const missingFields: string[] = [];

  for (const { canonical, spellings } of COUNTER_FIELDS) {
    const key = singleSpelling(summary, canonical, spellings);
    const suppressed = gated && GATE_SUPPRESSED_FIELDS.has(canonical);

    if (key === undefined) {
      values.set(canonical, null);

      if (!suppressed && (MANDATORY_SUMMARY_FIELDS as readonly string[]).includes(canonical)) {
        missingFields.push(canonical);
      }

      continue;
    }

    // Validate BEFORE suppressing, so a gated sweep sending `produced: "lots"` is still
    // a 400. Suppression is about not laundering a number, not about skipping the check.
    const count = requireCount(key, summary[key]);

    values.set(canonical, suppressed ? null : count);
  }

  return {
    checked: values.get("checked") ?? null,
    errors: values.get("errors") ?? null,
    expectedIntervalMs: values.get("expected_interval_ms") ?? null,
    gateState,
    missingFields,
    produced: values.get("produced") ?? null,
    queueDepth: values.get("queue_depth") ?? null,
    summaryStatus: "parsed",
    unrecognisedFields: collectUnrecognised(summary),
    vendorCalls: values.get("vendor_calls") ?? null,
  };
}

/**
 * THE DERIVED VERDICT — the single most important line in this design.
 * `ok = exit_code === 0 && (errors ?? 0) === 0`. A summary that did not report `errors`
 * falls back to the exit code alone (and has `errors` on its upgrade queue for exactly
 * that reason); a summary that reported errors can never be talked out of them.
 */
export function deriveRunOk(exitCode: number, errors: null | number): boolean {
  return exitCode === 0 && (errors ?? 0) === 0;
}

/**
 * The deterministic idempotency key: `${unit}:${startedAt}`, derived from the envelope
 * the wrapper already sends rather than constructed by it. Inserted
 * `ON CONFLICT(id) DO NOTHING`, so a retried best-effort POST collapses to ONE row —
 * an append-only ledger double-counts a retry otherwise. A systemd timer cannot start
 * the same unit twice at the same instant, so the pair is unique by construction.
 */
export function runEventId(parts: { startedAt: string; unit: string }): string {
  return `${parts.unit}:${parts.startedAt}`;
}

/**
 * The run's wall-clock duration in ms, or NULL when either timestamp is unparseable or
 * the pair runs backwards (clock skew). Recorded as unknown rather than as 0 — 0 would
 * read as an instantaneous run, which is a different and false claim.
 */
export function runDurationMs(startedAt: string, endedAt: string): null | number {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);

  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }

  return end - start;
}

// The insert column order. One place, so the placeholder tuple and the arg push cannot
// drift (the `costs.ts` INSERT_COLUMNS precedent).
const INSERT_COLUMNS = [
  "id",
  "checked",
  "created_at",
  "ended_at",
  "errors",
  "exit_code",
  "expected_interval_ms",
  "gate_state",
  "missing_fields",
  "occurred_at",
  "ok",
  "produced",
  "queue_depth",
  "run_duration_ms",
  "summary_raw",
  "summary_status",
  "unit",
  "unrecognised_fields",
  "vendor_calls",
] as const;

/** What one `record_run` call actually did — the op's ack, computed here. */
export type RecordedRun = {
  id: string;
  inserted: number;
  missingFields: string[];
  runOk: boolean;
  /**
   * Whether a telemetry database existed and the write ran at all. Without this,
   * `inserted: 0` would mean BOTH "this was a retry" and "there is no ledger" — the
   * exact kind of ambiguity that let a broken sweep read as a healthy one for a week.
   */
  stored: boolean;
};

/**
 * Normalize, derive, and append one run event — IDEMPOTENTLY.
 *
 * Validation runs FIRST and unconditionally, so a lying summary is a 400 whether or not
 * a telemetry database is provisioned; an unprovisioned deployment must not become a
 * place where bad emitters go unnoticed. When `getTelemetryDb()` yields nothing (local
 * dev, tests, previews) the write degrades to a logged no-op and the ack says so — a
 * missing telemetry database can never break the product path it observes.
 */
export async function insertRunEvent(input: RunEventInput): Promise<RecordedRun> {
  const summary = normalizeRunSummary(input.summary_raw);
  const runOk = deriveRunOk(input.exit_code, summary.errors);
  const id = runEventId({ startedAt: input.started_at, unit: input.unit });
  const db = await getTelemetryDb();

  if (!db) {
    logEvent("warn", "telemetry.run-event-unprovisioned", { id, unit: input.unit });

    return { id, inserted: 0, missingFields: summary.missingFields, runOk, stored: false };
  }

  const result = await db.execute({
    args: [
      id,
      summary.checked,
      new Date().toISOString(),
      input.ended_at,
      summary.errors,
      input.exit_code,
      summary.expectedIntervalMs,
      summary.gateState,
      JSON.stringify(summary.missingFields),
      input.started_at,
      runOk ? 1 : 0,
      summary.produced,
      summary.queueDepth,
      runDurationMs(input.started_at, input.ended_at),
      input.summary_raw ?? null,
      summary.summaryStatus,
      input.unit,
      JSON.stringify(summary.unrecognisedFields),
      summary.vendorCalls,
    ],
    sql: `insert into run_events (${INSERT_COLUMNS.join(", ")})
      values (${INSERT_COLUMNS.map(() => "?").join(", ")})
      on conflict(id) do nothing`,
  });

  return {
    id,
    inserted: result.rowsAffected,
    missingFields: summary.missingFields,
    runOk,
    stored: true,
  };
}
