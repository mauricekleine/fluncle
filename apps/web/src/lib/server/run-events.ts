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
//   1. `ok` IS AN AUTHORITY, NOT A ROW. The verdict is DERIVED —
//      `exit_code === 0 && (errors ?? 0) === 0` — and a caller's `ok` never sets it. But
//      a summary that carries one is RECORDED, not rejected: 25 of the fleet's sweeps print
//      `ok` in their summary line today, the nightly Sentry sweep's
//      `{"candidates":N,"ok":true,"resolved":N}` among them — the very self-asserted lie
//      this ledger was built to catch. Rejecting it would produce NO ROW for exactly those
//      sweeps (plus the four shell ones and the three new host units), and a missing row reads as
//      a dead sweep, so the founding case would have been the one case the ledger could
//      not see. The claim lands in `self_asserted_ok` instead, beside the derived truth,
//      which makes `where self_asserted_ok = 1 and errors > 0` a one-line query for every
//      sweep lying about its own health.
//   2. A COUNTER IS A VALIDATED INTEGER OR A 400 — but an explicit `null` is neither.
//      `typeof === "number"` alone lets a float and a negative through into a column that
//      means "a count of work", and `ok` is derived from one of these numbers. A `null`,
//      though, is the emitter SAYING it does not know (the sonar freshen prints
//      `"checked":null` on a lock-skipped tick); that is stored as SQL NULL and is not a
//      validation failure. The adjacent real shape is a sweep reporting its failures as
//      `"failed":[]` — a different KEY, not a wrong type: rules 3 and 4 catch that one, by
//      putting `errors` on the upgrade queue and `failed` in `unrecognised_fields` instead
//      of letting the count vanish into a silent NULL.
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

import { type RunEventInput } from "@fluncle/contracts/orpc";
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
  { canonical: "errors", spellings: ["errors"] },
  { canonical: "expected_interval_ms", spellings: ["expectedIntervalMs", "expected_interval_ms"] },
  { canonical: "produced", spellings: ["produced"] },
  { canonical: "queue_depth", spellings: ["queueDepth", "queue_depth"] },
  { canonical: "vendor_calls", spellings: ["vendorCalls", "vendor_calls"] },
];

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

  return {
    checked: values.get("checked") ?? null,
    errors: values.get("errors") ?? null,
    expectedIntervalMs: values.get("expected_interval_ms") ?? null,
    gateState,
    missingFields,
    produced: values.get("produced") ?? null,
    queueDepth: values.get("queue_depth") ?? null,
    selfAssertedOk,
    summaryStatus: "parsed",
    unrecognisedFields: collectUnrecognised(summary, unreadableKey ? [unreadableKey] : []),
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
  const summary = normalizeRunSummary(input.summary_raw);
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
