// THE RUN LEDGER's server half — the normalization + the idempotent append into
// `run_events`, the one table of the SECOND database (`fluncle-telemetry`).
//
// Four seams live here, mirroring `costs.ts`:
//
//   - `normalizeRunSummary(summaryRaw)` — the pure parse/validate/derive step. It is
//     where every rule the design earned actually lives, and it is pure so a test can
//     exercise all of them without a database.
//   - `runEventId({ startedAt, unit })` — the deterministic idempotency key.
//   - `insertRunEvent(input)` — the idempotent APPEND
//     (`insert … on conflict(id) do nothing`), returning what was actually written.
//   - `readRunLedger(input)` — the operator read: filtered raw rows plus cheap
//     whole-window per-unit aggregates, keyset-paginated without inventing verdicts.
//
// WHAT THE RULES ARE FOR — each one was earned by a measured defect, not imagined:
//
//   1. `ok` IS AN AUTHORITY, NOT A ROW. The verdict is DERIVED —
//      `exit_code === 0 && (errors ?? 0) === 0` — and a caller's `ok` never sets it. But
//      a summary that carries one is RECORDED, not rejected: 25 of the fleet's sweeps print
//      `ok` in their summary line today, the nightly Sentry sweep's
//      `{"candidates":N,"ok":true,"resolved":N}` among them — the very self-asserted lie
//      this ledger was built to catch. Rejecting it would produce NO ROW for exactly those
//      sweeps (plus the four shell ones and the three new host units), and a missing row reads as
//      a dead sweep, so the founding case would have been the one case the ledger could
//      not see. The claim lands in `self_asserted_ok` instead, beside the derived truth,
//      which makes `where self_asserted_ok = 1 and ok = 0` a one-line query for every
//      sweep lying about its own health.
//   2. A COUNTER IS A VALIDATED INTEGER OR A 400 — but an explicit `null` is neither.
//      `typeof === "number"` alone lets a float and a negative through into a column that
//      means "a count of work", and `ok` is derived from one of these numbers. A `null`,
//      though, is the emitter SAYING it does not know (the sonar freshen prints
//      `"checked":null` on a lock-skipped tick); that is stored as SQL NULL and is not a
//      validation failure. Run failure reporting has one measured legacy shape that
//      normalizes without losing its signal: nullable `error` means zero for null and one
//      for a message. Canonical `errors` wins when a migrating emitter sends both. The
//      domain `failed` counter is still validated and preserved in `summary_raw`, but it
//      counts individual work items and NEVER feeds the run verdict.
//   3. MISSING FIELDS ARE RECORDED, NOT GUESSED. The mandatory counters a summary did
//      not carry are listed in `missing_fields`, and THAT LIST IS THE UPGRADE QUEUE.
//      A counter the Worker invented is a counter nobody can trust. "Did not carry" means
//      ABSENT — a field present as `null` is the sweep telling us it does not know, which
//      is not a gap in the sweep and does not belong on its worklist.
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
// precisely why delivery does not have to be guaranteed — and it is also why the set of
// things that produce a 400 is kept as small as the honesty rules allow.

import {
  type ReadRunLedgerInput,
  type RunEventInput,
  type RunLedgerPage,
  type RunLedgerRow,
  type RunLedgerUnitRollup,
} from "@fluncle/contracts/orpc";
import { runLedgerWriters } from "@fluncle/registry";
import { getTelemetryDb } from "./db";
import { logEvent } from "./log";
import { ApiError } from "./spotify";

/**
 * The closed gate vocabulary, mirroring the `run_events.gate_state` enum.
 *
 * SIX STATES, and the extra three are deliberate SLACK rather than dead weight.
 * `active`/`paused`/`disabled` are a sweep's own kill switch, and the fleet's emitters
 * currently spell every gated tick `paused`. `locked` (a tick that found the single-flight
 * lock held), `forced`, and `dry-run` are the three more precise words an emitter reaches
 * for naturally — the sonar freshen's own comments describe its ticks in exactly those
 * terms — so they are accepted here.
 *
 * WHY ACCEPT A WORD NOBODY SENDS YET: the vocabulary is fail-OPEN on purpose. A gate value
 * the Worker does not know is a 400, a 400 leaves NO ROW, and a missing row reads as a
 * missed run — so the cost of an unlisted word is a phantom dead sweep, while the cost of
 * an unused one is nothing. The enum stays CLOSED (an arbitrary string is still rejected);
 * it is just closed around the words a real emitter would plausibly choose.
 */
export type RunGateState = "active" | "disabled" | "dry-run" | "forced" | "locked" | "paused";

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
 * THE GATES THAT MEAN "THIS TICK NEVER LOOKED" — the only ones whose work counters are
 * suppressed to NULL (rule 5). A sweep that is paused, disabled, or skipped on a held
 * single-flight lock did not try, so its zeros are not readings.
 *
 * `forced` and `dry-run` are deliberately NOT here: both LOOKED. A forced run's counters
 * are real measurements and suppressing them would destroy the operator's own evidence; a
 * dry-run genuinely checked its worklist and then declined to write, so `produced: 0` is
 * the truth about it. The false `produced == 0 AND queue_depth > 0` alarm those two could
 * otherwise raise is the READER's to exclude — `gate_state` is on the row for exactly that
 * — and excluding a non-active gate at read time is strictly safer than laundering a
 * measured number at write time. An emitter that wants the suppression keeps saying
 * `paused`, which is what the fleet says today.
 */
const GATE_STATES_THAT_NEVER_LOOKED = new Set<string>(["disabled", "locked", "paused"]);

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
  { canonical: "expected_interval_ms", spellings: ["expectedIntervalMs", "expected_interval_ms"] },
  { canonical: "produced", spellings: ["produced"] },
  { canonical: "queue_depth", spellings: ["queueDepth", "queue_depth"] },
  { canonical: "vendor_calls", spellings: ["vendorCalls", "vendor_calls"] },
];

const CANONICAL_ERROR_SPELLINGS = ["errors"];
const DOMAIN_FAILED_SPELLINGS = ["failed"];
const LEGACY_ERROR_SPELLINGS = ["error"];
const GATE_STATE_SPELLINGS = ["gateState", "gate_state"];
const PAUSED_SPELLINGS = ["paused"];
const OK_SPELLINGS = ["ok"];
const GATE_STATES = new Set<string>([
  "active",
  "disabled",
  "dry-run",
  "forced",
  "locked",
  "paused",
]);

/** Every summary key the Worker recognises — anything else is `unrecognised_fields`. */
const RECOGNISED_KEYS = new Set<string>([
  ...COUNTER_FIELDS.flatMap((field) => field.spellings),
  ...CANONICAL_ERROR_SPELLINGS,
  ...DOMAIN_FAILED_SPELLINGS,
  ...LEGACY_ERROR_SPELLINGS,
  ...GATE_STATE_SPELLINGS,
  ...PAUSED_SPELLINGS,
  ...OK_SPELLINGS,
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
  /**
   * The health the emitter CLAIMED, when it claimed one — recorded, never obeyed. NULL
   * means the summary made no readable claim. Its whole purpose is to sit beside the
   * derived verdict so the contradiction is queryable rather than argued about.
   */
  selfAssertedOk: boolean | null;
  summaryStatus: RunSummaryStatus;
  unrecognisedFields: string[];
  vendorCalls: null | number;
};

function reject(message: string): never {
  throw new ApiError("invalid_run_summary", message, 400);
}

/**
 * A counter must be a finite, non-negative INTEGER — rule 2. `Number.isInteger` is doing
 * the work a bare `typeof` check cannot: it rejects a float, an infinity, and a NaN, and
 * the `< 0` rejects a negative. A present-but-wrong-typed counter is a 400 rather than a
 * silent NULL, because `ok` is derived from one of these numbers. (An explicit `null` never
 * reaches here — `readField` classifies it as `declared-unknown` first.)
 */
function requireCount(field: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    reject(
      `run summary field "${field}" must be a non-negative integer, got ${JSON.stringify(value)}`,
    );
  }

  return value;
}

/**
 * THREE STATES, not two — the distinction that decides whether a real sweep gets a row.
 *
 *   - `absent` — the summary never mentioned the field. A gap in the SWEEP, so a mandatory
 *     one lands on the upgrade queue.
 *   - `declared-unknown` — the field is there, holding `null`. The sweep is TELLING us it
 *     does not know (the sonar freshen prints `"checked":null` on a lock-skipped tick, and
 *     `"gateState":null` on every ordinary one). Stored as SQL NULL, and pointedly NOT on
 *     the upgrade queue: `missing_fields` means "the sweep never told us", not "the sweep
 *     told us it does not know". Filing it would manufacture a worklist item against a
 *     sweep that is already doing the right thing.
 *   - `value` — a real reading, to be validated.
 */
type SummaryField =
  | { key: string; kind: "declared-unknown" }
  | { key: string; kind: "value"; value: unknown }
  | { kind: "absent" };

/**
 * Read one logical field across its allowed spellings.
 *
 * A `null` IS NOT A SIGNAL, which is what makes the two contradiction rules behave: a
 * summary carrying `queueDepth: 5` alongside `queue_depth: null` is not a contradiction,
 * and `gateState: null` alongside `paused: true` is one gate signal, not two. Only VALUES
 * can contradict each other.
 */
function readField(
  summary: Record<string, unknown>,
  canonical: string,
  spellings: string[],
): SummaryField {
  const present = spellings.filter((spelling) => Object.hasOwn(summary, spelling));
  const valued = present.filter((spelling) => summary[spelling] !== null);

  if (valued.length > 1) {
    reject(
      `run summary carries "${canonical}" under more than one spelling (${valued.join(", ")}) — send exactly one`,
    );
  }

  const [valuedKey] = valued;

  if (valuedKey !== undefined) {
    return { key: valuedKey, kind: "value", value: summary[valuedKey] };
  }

  const [presentKey] = present;

  return presentKey === undefined
    ? { kind: "absent" }
    : { key: presentKey, kind: "declared-unknown" };
}

/**
 * Normalize the run-level error shapes already present in the fleet.
 *
 * `errors` is the canonical integer and wins whenever it is present. The legacy `error`
 * shape is a nullable run-failure message (`null` explicitly means zero, any string means
 * one). The domain `failed` shape is still validated as either an integer count or an
 * array, and remains preserved in `summary_raw`, but it counts individual work items and
 * NEVER becomes canonical `errors`. Only absence of both run-level shapes is MISSING.
 */
function readErrors(summary: Record<string, unknown>): SummaryField {
  const canonical = readField(summary, "errors", CANONICAL_ERROR_SPELLINGS);
  const failed = readField(summary, "failed", DOMAIN_FAILED_SPELLINGS);
  const error = readField(summary, "error", LEGACY_ERROR_SPELLINGS);

  if (failed.kind === "value") {
    if (!Array.isArray(failed.value)) {
      requireCount(failed.key, failed.value);
    }
  }

  let normalizedError: SummaryField = error;

  if (error.kind === "declared-unknown") {
    normalizedError = { key: error.key, kind: "value", value: 0 };
  } else if (error.kind === "value") {
    if (typeof error.value !== "string") {
      reject(
        `run summary field "${error.key}" must be a string or null, got ${JSON.stringify(error.value)}`,
      );
    }

    normalizedError = { key: error.key, kind: "value", value: 1 };
  }

  // Validate canonical errors even though requireCount is normally called by the generic
  // counter loop below. It is deliberately separate so the legacy domain fields can
  // coexist with it without being treated as contradictory spellings.
  const normalizedCanonical =
    canonical.kind === "value"
      ? {
          key: canonical.key,
          kind: "value" as const,
          value: requireCount(canonical.key, canonical.value),
        }
      : canonical;

  if (normalizedCanonical.kind !== "absent") {
    return normalizedCanonical;
  }

  return normalizedError;
}

/** The gate, from either `paused` (boolean) or `gateState` (the closed enum). */
function readGateState(summary: Record<string, unknown>): null | RunGateState {
  const gate = readField(summary, "gate_state", GATE_STATE_SPELLINGS);
  const paused = readField(summary, "paused", PAUSED_SPELLINGS);

  if (gate.kind === "value" && paused.kind === "value") {
    // One gate signal per summary. Two can disagree, and a ledger that exists to catch
    // a self-contradicting summary cannot begin by reconciling one.
    reject(
      `run summary carries both "${gate.key}" and "${paused.key}" — send exactly one gate signal`,
    );
  }

  if (gate.kind === "value") {
    if (typeof gate.value !== "string" || !GATE_STATES.has(gate.value)) {
      reject(
        `run summary field "${gate.key}" must be one of ${[...GATE_STATES].sort().join("/")}, got ${JSON.stringify(gate.value)}`,
      );
    }

    return gate.value as RunGateState;
  }

  if (paused.kind === "value") {
    if (typeof paused.value !== "boolean") {
      reject(
        `run summary field "${paused.key}" must be a boolean, got ${JSON.stringify(paused.value)}`,
      );
    }

    return paused.value ? "paused" : "active";
  }

  return null;
}

function truncateName(name: string): string {
  return name.length > MAX_FIELD_NAME_CHARS ? `${name.slice(0, MAX_FIELD_NAME_CHARS - 1)}…` : name;
}

/**
 * THE CLAIM, recorded and never obeyed (rule 1). A boolean `ok` becomes
 * `self_asserted_ok`; anything else — a present-but-unreadable claim — yields NULL and is
 * reported back so it lands in `unrecognised_fields`, because a self-assessment the Worker
 * could not read must not vanish silently either.
 */
function readSelfAssertedOk(summary: Record<string, unknown>): {
  selfAssertedOk: boolean | null;
  unreadableKey: string | undefined;
} {
  const claim = readField(summary, "ok", OK_SPELLINGS);

  if (claim.kind !== "value") {
    return { selfAssertedOk: null, unreadableKey: undefined };
  }

  if (typeof claim.value !== "boolean") {
    return { selfAssertedOk: null, unreadableKey: claim.key };
  }

  return { selfAssertedOk: claim.value, unreadableKey: undefined };
}

/** The unrecognised keys, sorted, bounded, with the overflow COUNTED rather than dropped. */
function collectUnrecognised(summary: Record<string, unknown>, alsoUnknown: string[]): string[] {
  const unknown = [
    ...Object.keys(summary).filter((key) => !RECOGNISED_KEYS.has(key)),
    ...alsoUnknown,
  ]
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
    selfAssertedOk: null,
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
 * It DOES throw (a 400) for a summary that CONTRADICTS ITSELF or is structurally
 * untrustworthy: a wrong-typed counter, one field under two spellings, two gate signals, a
 * gate outside the vocabulary. Those are emitter bugs the ledger must not absorb.
 *
 * A SELF-ASSERTED `ok` IS NOT ONE OF THEM. It is recorded in `selfAssertedOk` and
 * overruled by the derivation — see rule 1 in the file header. Rejecting it would have
 * produced no row for the 25 sweeps that print `ok`, the founding Sentry case included,
 * and a missing row reads as a dead sweep.
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

  // Rule 1: the emitter's claim is RECORDED here and overruled by `deriveRunOk` below. It
  // is never obeyed, and it never costs the sweep its row.
  const { selfAssertedOk, unreadableKey } = readSelfAssertedOk(summary);
  const gateState = readGateState(summary);
  // A sweep behind a closed gate never looked, so it owes no work counters and must not
  // report 0 for them (rule 5). `errors` and `expected_interval_ms` stay owing: one is a
  // failure signal, the other describes the schedule rather than the run.
  const gated = GATE_STATES_THAT_NEVER_LOOKED.has(gateState ?? "");

  const values = new Map<string, null | number>();
  const missingFields: string[] = [];

  const errors = readErrors(summary);

  if (errors.kind === "absent") {
    values.set("errors", null);
    missingFields.push("errors");
  } else if (errors.kind === "declared-unknown") {
    values.set("errors", null);
  } else {
    values.set("errors", requireCount(errors.key, errors.value));
  }

  for (const { canonical, spellings } of COUNTER_FIELDS) {
    const field = readField(summary, canonical, spellings);
    const suppressed = gated && GATE_SUPPRESSED_FIELDS.has(canonical);

    if (field.kind !== "value") {
      values.set(canonical, null);

      // ABSENT files an upgrade-queue item; DECLARED-UNKNOWN does not. The sweep that
      // prints `"checked":null` on a gated tick is behaving correctly and must not be
      // handed a worklist item for saying so.
      if (
        field.kind === "absent" &&
        !suppressed &&
        (MANDATORY_SUMMARY_FIELDS as readonly string[]).includes(canonical)
      ) {
        missingFields.push(canonical);
      }

      continue;
    }

    // Validate BEFORE suppressing, so a gated sweep sending `produced: "lots"` is still
    // a 400. Suppression is about not laundering a number, not about skipping the check.
    const count = requireCount(field.key, field.value);

    values.set(canonical, suppressed ? null : count);
  }

  const orderedMissingFields = MANDATORY_SUMMARY_FIELDS.filter((field) =>
    missingFields.includes(field),
  );

  return {
    checked: values.get("checked") ?? null,
    errors: values.get("errors") ?? null,
    expectedIntervalMs: values.get("expected_interval_ms") ?? null,
    gateState,
    missingFields: orderedMissingFields,
    produced: values.get("produced") ?? null,
    queueDepth: values.get("queue_depth") ?? null,
    selfAssertedOk,
    summaryStatus: "parsed",
    unrecognisedFields: collectUnrecognised(summary, unreadableKey ? [unreadableKey] : []),
    vendorCalls: values.get("vendor_calls") ?? null,
  };
}

const RUN_LEDGER_WRITERS = runLedgerWriters();
const RUN_LEDGER_CADENCE_MS = new Map(
  RUN_LEDGER_WRITERS.map((writer) => [writer.unit, writer.expectedIntervalMs]),
);

/**
 * Apply the roster's authoritative cadence to a normalized summary.
 *
 * The unit name in the strict envelope is the join key to `runLedgerWriters()`. A roster
 * unit's cadence is schedule data, not something its work summary gets to redefine, so
 * the registry value replaces any emitted fallback and satisfies the mandatory field
 * even when the summary was absent or malformed. Unregistered legacy units keep their
 * emitted value (or their missing-field item) for backwards compatibility.
 */
export function withRegisteredCronCadence(
  unit: string,
  summary: NormalizedRunSummary,
): NormalizedRunSummary {
  const cadenceMs = RUN_LEDGER_CADENCE_MS.get(unit);

  if (cadenceMs === undefined) {
    return summary;
  }

  return {
    ...summary,
    expectedIntervalMs: cadenceMs,
    missingFields: summary.missingFields.filter((field) => field !== "expected_interval_ms"),
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
  "self_asserted_ok",
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
   * The health the summary CLAIMED, when it made a readable claim — handed back so a curl
   * against the op shows the claim and the verdict side by side. NULL means no claim.
   */
  selfAssertedOk: boolean | null;
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
  const summary = withRegisteredCronCadence(input.unit, normalizeRunSummary(input.summary_raw));
  const runOk = deriveRunOk(input.exit_code, summary.errors);
  const id = runEventId({ startedAt: input.started_at, unit: input.unit });
  const db = await getTelemetryDb();

  if (!db) {
    logEvent("warn", "telemetry.run-event-unprovisioned", { id, unit: input.unit });

    return {
      id,
      inserted: 0,
      missingFields: summary.missingFields,
      runOk,
      selfAssertedOk: summary.selfAssertedOk,
      stored: false,
    };
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
      summary.selfAssertedOk === null ? null : Number(summary.selfAssertedOk),
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
    selfAssertedOk: summary.selfAssertedOk,
    stored: true,
  };
}

type RunLedgerCursor = {
  id: string;
  occurredAt: string;
};

type RunLedgerDbRow = {
  checked: unknown;
  created_at: unknown;
  ended_at: unknown;
  errors: unknown;
  exit_code: unknown;
  expected_interval_ms: unknown;
  gate_state: unknown;
  id: unknown;
  missing_fields: unknown;
  occurred_at: unknown;
  ok: unknown;
  produced: unknown;
  queue_depth: unknown;
  run_duration_ms: unknown;
  self_asserted_ok: unknown;
  summary_raw: unknown;
  summary_status: unknown;
  unit: unknown;
  unrecognised_fields: unknown;
  vendor_calls: unknown;
};

type RunLedgerRollupDbRow = {
  blind_count: unknown;
  failed_count: unknown;
  last_occurred_at: unknown;
  liar_count: unknown;
  run_count: unknown;
  unit: unknown;
};

function ledgerText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`run_events.${field} was not text`);
  }

  return value;
}

function ledgerNumber(value: unknown, field: string): number {
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`run_events.${field} was not numeric`);
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    throw new Error(`run_events.${field} was not numeric`);
  }

  return number;
}

function nullableLedgerNumber(value: unknown, field: string): number | null {
  return value === null ? null : ledgerNumber(value, field);
}

function nullableLedgerBoolean(value: unknown, field: string): boolean | null {
  if (value === null) {
    return null;
  }

  const number = ledgerNumber(value, field);

  if (number !== 0 && number !== 1) {
    throw new Error(`run_events.${field} was not 0 or 1`);
  }

  return number === 1;
}

function ledgerBoolean(value: unknown, field: string): boolean {
  const boolean = nullableLedgerBoolean(value, field);

  if (boolean === null) {
    throw new Error(`run_events.${field} was null`);
  }

  return boolean;
}

function ledgerStringArray(value: unknown, field: string): string[] {
  const text = ledgerText(value, field);
  const parsed = JSON.parse(text) as unknown;

  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`run_events.${field} was not a JSON string array`);
  }

  return parsed;
}

function ledgerGateState(value: unknown): RunGateState | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string" || !GATE_STATES.has(value)) {
    throw new Error("run_events.gate_state was not a known gate state");
  }

  return value as RunGateState;
}

function ledgerSummaryStatus(value: unknown): RunSummaryStatus {
  if (value !== "absent" && value !== "malformed" && value !== "not_object" && value !== "parsed") {
    throw new Error("run_events.summary_status was not a known summary status");
  }

  return value;
}

function toRunLedgerRow(row: RunLedgerDbRow): RunLedgerRow {
  return {
    checked: nullableLedgerNumber(row.checked, "checked"),
    createdAt: ledgerText(row.created_at, "created_at"),
    endedAt: ledgerText(row.ended_at, "ended_at"),
    errors: nullableLedgerNumber(row.errors, "errors"),
    exitCode: ledgerNumber(row.exit_code, "exit_code"),
    expectedIntervalMs: nullableLedgerNumber(row.expected_interval_ms, "expected_interval_ms"),
    gateState: ledgerGateState(row.gate_state),
    id: ledgerText(row.id, "id"),
    missingFields: ledgerStringArray(row.missing_fields, "missing_fields"),
    occurredAt: ledgerText(row.occurred_at, "occurred_at"),
    ok: ledgerBoolean(row.ok, "ok"),
    produced: nullableLedgerNumber(row.produced, "produced"),
    queueDepth: nullableLedgerNumber(row.queue_depth, "queue_depth"),
    runDurationMs: nullableLedgerNumber(row.run_duration_ms, "run_duration_ms"),
    selfAssertedOk: nullableLedgerBoolean(row.self_asserted_ok, "self_asserted_ok"),
    summaryRaw: row.summary_raw === null ? null : ledgerText(row.summary_raw, "summary_raw"),
    summaryStatus: ledgerSummaryStatus(row.summary_status),
    unit: ledgerText(row.unit, "unit"),
    unrecognisedFields: ledgerStringArray(row.unrecognised_fields, "unrecognised_fields"),
    vendorCalls: nullableLedgerNumber(row.vendor_calls, "vendor_calls"),
  };
}

function toRunLedgerRollup(row: RunLedgerRollupDbRow): RunLedgerUnitRollup {
  const unit = ledgerText(row.unit, "unit");

  return {
    blindCount: ledgerNumber(row.blind_count, "blind_count"),
    expectedIntervalMs: RUN_LEDGER_CADENCE_MS.get(unit) ?? null,
    failedCount: ledgerNumber(row.failed_count, "failed_count"),
    lastOccurredAt: ledgerText(row.last_occurred_at, "last_occurred_at"),
    liarCount: ledgerNumber(row.liar_count, "liar_count"),
    runCount: ledgerNumber(row.run_count, "run_count"),
    unit,
  };
}

export function encodeRunLedgerCursor(cursor: RunLedgerCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeRunLedgerCursor(value: string | undefined): RunLedgerCursor | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as RunLedgerCursor).id === "string" &&
      typeof (parsed as RunLedgerCursor).occurredAt === "string"
    ) {
      return parsed as RunLedgerCursor;
    }
  } catch {
    // Fall through to the one client-facing error below.
  }

  throw new ApiError("invalid_cursor", "Invalid run-ledger cursor", 400);
}

const RELATIVE_SINCE_PATTERN = /^([1-9][0-9]*)(m|h|d|w)$/;
const RELATIVE_SINCE_MAX_MS = 3650 * 24 * 60 * 60 * 1000;
const RELATIVE_SINCE_UNIT_MS = {
  d: 24 * 60 * 60 * 1000,
  h: 60 * 60 * 1000,
  m: 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
} as const;

function relativeRunLedgerDurationMs(value: string): number | null {
  const match = RELATIVE_SINCE_PATTERN.exec(value);

  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  const unit = match[2] as keyof typeof RELATIVE_SINCE_UNIT_MS;
  const durationMs = amount * RELATIVE_SINCE_UNIT_MS[unit];

  return Number.isSafeInteger(durationMs) && durationMs <= RELATIVE_SINCE_MAX_MS
    ? durationMs
    : null;
}

function normalizedRunLedgerSince(value: string | undefined, nowMs: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const durationMs = relativeRunLedgerDurationMs(value);
  const date = new Date(durationMs === null ? value : nowMs - durationMs);

  if (!Number.isFinite(date.getTime())) {
    throw new ApiError("invalid_time_bound", "Invalid run-ledger since bound", 400);
  }

  return date.toISOString();
}

function normalizedRunLedgerUntil(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    throw new ApiError("invalid_time_bound", "Invalid run-ledger until bound", 400);
  }

  return date.toISOString();
}

/**
 * Read one newest-first page plus whole-window per-unit aggregates.
 *
 * Unit/time define the rollup frame. Stored evidence filters (`ok`, `liar`, `blind`,
 * `missingField`) narrow only rows and their `totalCount`, so RUNS always means every run
 * in the unit/time window. `missing=true` is a separate roster-absence view driven by one
 * DISTINCT query over that same unit/time scope. The keyset cursor applies only to the raw
 * page. All time comparisons use normalized ISO strings with a `T` separator; SQLite's
 * space-shaped `datetime('now', …)` output never enters the query.
 */
export async function readRunLedger(
  input: ReadRunLedgerInput,
  nowMs = Date.now(),
): Promise<RunLedgerPage> {
  const db = await getTelemetryDb();

  if (!db) {
    return {
      available: false,
      missingRoster: [],
      nextCursor: null,
      rollups: [],
      rows: [],
      totalCount: 0,
    };
  }

  const scopeClauses: string[] = [];
  const scopeArgs: (number | string)[] = [];
  const since = normalizedRunLedgerSince(input.since, nowMs);
  const until = normalizedRunLedgerUntil(input.until);

  if (input.unit !== undefined) {
    scopeClauses.push("unit = ?");
    scopeArgs.push(input.unit);
  }

  if (since !== undefined) {
    scopeClauses.push("occurred_at >= ?");
    scopeArgs.push(since);
  }

  if (until !== undefined) {
    scopeClauses.push("occurred_at <= ?");
    scopeArgs.push(until);
  }

  if (since !== undefined && until !== undefined && since > until) {
    throw new ApiError("invalid_time_window", "since must be before or equal to until", 400);
  }

  const scopeWhere = scopeClauses.length === 0 ? "" : `where ${scopeClauses.join(" and ")}`;

  if (input.missing === "true") {
    const presentResult = await db.execute({
      args: scopeArgs,
      sql: `select distinct unit
            from run_events
            ${scopeWhere}`,
    });
    const presentUnits = new Set(presentResult.rows.map((row) => ledgerText(row.unit, "unit")));
    const missingRoster = RUN_LEDGER_WRITERS.filter(
      (writer) =>
        (input.unit === undefined || writer.unit === input.unit) && !presentUnits.has(writer.unit),
    );

    return {
      available: true,
      missingRoster,
      nextCursor: null,
      rollups: [],
      rows: [],
      totalCount: 0,
    };
  }

  const evidenceClauses = [...scopeClauses];
  const evidenceArgs = [...scopeArgs];

  if (input.ok !== undefined) {
    evidenceClauses.push("ok = ?");
    evidenceArgs.push(input.ok === "true" ? 1 : 0);
  }

  if (input.liar !== undefined) {
    const liar = "coalesce(self_asserted_ok, 0) = 1 and ok = 0";

    evidenceClauses.push(input.liar === "true" ? `(${liar})` : `not (${liar})`);
  }

  if (input.blind !== undefined) {
    const blind = "checked is null and produced is null and queue_depth is null";

    evidenceClauses.push(input.blind === "true" ? `(${blind})` : `not (${blind})`);
  }

  if (input.missingField !== undefined) {
    evidenceClauses.push(
      `exists (
        select 1
        from json_each(run_events.missing_fields) as missing_field
        where missing_field.value = ?
      )`,
    );
    evidenceArgs.push(input.missingField);
  }

  const evidenceWhere =
    evidenceClauses.length === 0 ? "" : `where ${evidenceClauses.join(" and ")}`;
  const cursor = decodeRunLedgerCursor(input.cursor);
  const pageClauses = [...evidenceClauses];
  const pageArgs = [...evidenceArgs];

  if (cursor !== undefined) {
    pageClauses.push("(occurred_at < ? or (occurred_at = ? and id < ?))");
    pageArgs.push(cursor.occurredAt, cursor.occurredAt, cursor.id);
  }

  const pageWhere = pageClauses.length === 0 ? "" : `where ${pageClauses.join(" and ")}`;
  pageArgs.push(input.limit + 1);

  const [pageResult, rollupResult, countResult] = await Promise.all([
    db.execute({
      args: pageArgs,
      sql: `select checked, created_at, ended_at, errors, exit_code,
                   expected_interval_ms, gate_state, id, missing_fields, occurred_at,
                   ok, produced, queue_depth, run_duration_ms, self_asserted_ok,
                   summary_raw, summary_status, unit, unrecognised_fields, vendor_calls
            from run_events
            ${pageWhere}
            order by occurred_at desc, id desc
            limit ?`,
    }),
    db.execute({
      args: scopeArgs,
      sql: `select unit,
                   count(*) as run_count,
                   max(occurred_at) as last_occurred_at,
                   sum(case when ok = 0 then 1 else 0 end) as failed_count,
                   sum(case when self_asserted_ok = 1 and ok = 0 then 1 else 0 end)
                     as liar_count,
                   sum(case when checked is null and produced is null and queue_depth is null
                       then 1 else 0 end) as blind_count
            from run_events
            ${scopeWhere}
            group by unit
            order by last_occurred_at desc, unit asc`,
    }),
    db.execute({
      args: evidenceArgs,
      sql: `select count(*) as total_count
            from run_events
            ${evidenceWhere}`,
    }),
  ]);

  const allRows = (pageResult.rows as unknown as RunLedgerDbRow[]).map(toRunLedgerRow);
  const hasMore = allRows.length > input.limit;
  const rows = allRows.slice(0, input.limit);
  const lastRow = rows.at(-1);
  const nextCursor =
    hasMore && lastRow
      ? encodeRunLedgerCursor({ id: lastRow.id, occurredAt: lastRow.occurredAt })
      : null;
  const rollups = (rollupResult.rows as unknown as RunLedgerRollupDbRow[]).map(toRunLedgerRollup);
  const totalCount = ledgerNumber(countResult.rows[0]?.total_count, "total_count");

  return {
    available: true,
    missingRoster: [],
    nextCursor,
    rollups,
    rows,
    totalCount,
  };
}
