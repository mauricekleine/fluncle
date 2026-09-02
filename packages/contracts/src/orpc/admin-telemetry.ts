// The `admin-telemetry` domain contract module — the run ledger, `run_events`, which
// lives in the SECOND database (`fluncle-telemetry`).
//
//   - `record_run` — POST /admin/telemetry/runs. Body: ONE envelope per sweep tick,
//     posted by `emit_cron_output` (the shared bash wrapper every host-timer sweep
//     already goes through). Bash stays dumb; the WORKER owns the schema, so no
//     per-sweep code change is required for v1.
//   - `read_run_ledger` — GET /admin/telemetry/runs. Operator-only rows plus cheap
//     per-unit aggregates over the requested unit/time window. Stored evidence filters
//     narrow rows, never those all-run rollups. It returns evidence, never a fixed
//     "broken sweep" verdict.
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
const MAX_RUN_RELEASE_CHARS = 64;
const RUN_OPERATION_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const RUN_RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A defensive cap for run-measured database attempts and batch statements. Real runs are
 * orders of magnitude smaller; this prevents a broken emitter from turning a counter into
 * an unbounded integer while preserving every credible aggregate.
 */
export const MAX_RUN_DATABASE_COUNT = 1_000_000;

/** These are kept equal to the server's public-safe database observability vocabulary. */
const RunDatabaseAccessClassSchema = z.enum(["heavy-read", "read", "write"]);
const RunDatabaseOutcomeSchema = z.enum(["failure", "success"]);

/** A read page is deliberately bounded even behind the operator token. */
export const MAX_RUN_LEDGER_PAGE_SIZE = 100;

/** The opaque keyset cursor is two already-bounded strings encoded as base64url JSON. */
const MAX_RUN_LEDGER_CURSOR_CHARS = 512;

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
 * SUMMARY COUNTER CONVENTION. A sweep emits these canonical fields alongside its
 * existing domain counters; the domain counters remain useful forensic detail:
 *   - `checked` is the denominator: units the tick actually looked at.
 *   - `produced` is the numerator: units the tick successfully acted on.
 *   - `queue_depth` is the real outstanding backlog remaining after the tick. It is
 *     NEVER a batch limit, page size, or fetched-page cap; omit it when the emitter
 *     cannot obtain a real outstanding count.
 *   - `errors` means the run itself failed; `failed` means individual work items failed and the run continued.
 *
 * NULL IS NOT ZERO. `0` is a measured answer ("looked and found none", "no failures");
 * `null` explicitly says the emitter cannot know, and absence says it did not report the
 * counter. The ledger preserves all three states. `expected_interval_ms` is schedule
 * metadata derived server-side from `@fluncle/registry` for roster-known units; only
 * unregistered legacy units retain an emitted fallback.
 *
 * `z.strictObject` — an UNKNOWN envelope key is REJECTED, never ignored. This is the
 * posture `docs/vector-serving.md` already ratified for the sonar filter: a version skew
 * between the wrapper and the Worker must DEGRADE LOUDLY rather than silently widen into
 * a field nobody validated. A rejected POST leaves a missing row, and a missing row
 * looks like a missed run, which the roster alarms on — so even the failure is visible.
 *
 * NOTE WHAT IS ABSENT: there is no `ok`, and there is no `id`.
 *   - `ok` is DERIVED by the Worker (`exit_code === 0 && (errors ?? 0) === 0`), so the
 *     ENVELOPE has no slot for one and `z.strictObject` rejects a caller that invents it.
 *     The nightly Sentry sweep exited 0 for ELEVEN nights while printing
 *     `{"errors":2,"ok":true}`: a hardcoded literal sitting beside the number that
 *     contradicted it. A ledger that accepts a self-assessment inherits the lie.
 *
 *     An `ok` INSIDE `summary_raw` is a different matter and is deliberately NOT rejected:
 *     25 sweep scripts print one today, so a rejection would leave exactly those sweeps —
 *     the founding case among them — with no row, and a missing row reads as a dead sweep.
 *     The Worker records that claim in `self_asserted_ok` and overrules it, which turns
 *     `where self_asserted_ok = 1 and ok = 0` into the query that finds the liars.
 *   - `id` is derived from `${unit}:${started_at}`, which this envelope already pins, so
 *     the idempotency key is deterministic without the wrapper having to construct one.
 */
export const RunEventInputSchema = z
  .strictObject({
    /** Measured database attempts across the run; null/absence means unknowable. */
    attempt_count: z.number().int().nonnegative().max(MAX_RUN_DATABASE_COUNT).nullish(),
    /** Measured statements submitted in batches; null/absence means unknowable. */
    batch_count: z.number().int().nonnegative().max(MAX_RUN_DATABASE_COUNT).nullish(),
    /** ISO box time the run finished. */
    ended_at: z.string().min(1).max(MAX_TIMESTAMP_CHARS),
    /** The process exit code. Bash `$?` is definitionally 0–255; anything else is a broken emitter. */
    exit_code: z.number().int().min(0).max(255),
    /** Bounded public build identifier of the emitter; null/absence degrades to `unknown`. */
    release: z.string().min(1).max(MAX_RUN_RELEASE_CHARS).regex(RUN_RELEASE_PATTERN).nullish(),
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

const RunLedgerTimestampSchema = z.iso
  .datetime({ offset: true })
  .max(MAX_TIMESTAMP_CHARS)
  .describe("ISO-8601 bound on occurredAt (box time)");

const RELATIVE_SINCE_PATTERN = /^[1-9][0-9]*(m|h|d|w)$/;
const RELATIVE_SINCE_MAX_CHARS = 32;
const RELATIVE_SINCE_MAX_MS = 3650 * 24 * 60 * 60 * 1000;
const RELATIVE_SINCE_UNIT_MS = {
  d: 24 * 60 * 60 * 1000,
  h: 60 * 60 * 1000,
  m: 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
} as const;

function relativeSinceMs(value: string): number | null {
  const match = RELATIVE_SINCE_PATTERN.exec(value);

  if (!match) {
    return null;
  }

  const amount = Number(match[0].slice(0, -1));
  const unit = match[1] as keyof typeof RELATIVE_SINCE_UNIT_MS;
  const durationMs = amount * RELATIVE_SINCE_UNIT_MS[unit];

  return Number.isSafeInteger(durationMs) && durationMs <= RELATIVE_SINCE_MAX_MS
    ? durationMs
    : null;
}

const RunLedgerRelativeSinceSchema = z
  .string()
  .max(RELATIVE_SINCE_MAX_CHARS)
  .refine((value) => relativeSinceMs(value) !== null, {
    message: "since must be an ISO-8601 instant or a positive m/h/d/w duration up to 3650d",
  })
  .describe("Relative lookback such as 90m, 24h, 7d, or 2w");

/** One raw ledger row, projected losslessly apart from JSON/boolean decoding. */
export const RunLedgerRowSchema = z.object({
  accessClass: RunDatabaseAccessClassSchema.nullable(),
  attemptCount: z.number().int().nonnegative().max(MAX_RUN_DATABASE_COUNT).nullable(),
  batchCount: z.number().int().nonnegative().max(MAX_RUN_DATABASE_COUNT).nullable(),
  checked: z.number().int().nullable(),
  createdAt: z.string(),
  endedAt: z.string(),
  errors: z.number().int().nullable(),
  exitCode: z.number().int(),
  expectedIntervalMs: z.number().int().nullable(),
  gateState: z
    .enum(["active", "admission-skipped", "disabled", "dry-run", "forced", "locked", "paused"])
    .nullable(),
  id: z.string(),
  missingFields: z.array(z.string()),
  occurredAt: z.string(),
  ok: z.boolean(),
  operationId: z.string().min(1).max(64).regex(RUN_OPERATION_ID_PATTERN).nullable(),
  outcome: RunDatabaseOutcomeSchema,
  produced: z.number().int().nullable(),
  queueDepth: z.number().int().nullable(),
  release: z.string().min(1).max(MAX_RUN_RELEASE_CHARS).regex(RUN_RELEASE_PATTERN),
  runDurationMs: z.number().int().nullable(),
  selfAssertedOk: z.boolean().nullable(),
  summaryRaw: z.string().nullable(),
  summaryStatus: z.enum(["absent", "malformed", "not_object", "parsed"]),
  unit: z.string(),
  unrecognisedFields: z.array(z.string()),
  vendorCalls: z.number().int().nullable(),
});

/** Cheap facts for one unit over the full unit/time window, independent of evidence filters. */
export const RunLedgerUnitRollupSchema = z.object({
  blindCount: z.number().int().nonnegative(),
  expectedIntervalMs: z.number().int().nullable(),
  failedCount: z.number().int().nonnegative(),
  lastOccurredAt: z.string(),
  liarCount: z.number().int().nonnegative(),
  runCount: z.number().int().nonnegative(),
  unit: z.string(),
});

/** One expected ledger writer with no stored row in the requested time/unit window. */
export const RunLedgerMissingRosterEntrySchema = z.object({
  expectedIntervalMs: z.number().int().positive(),
  unit: z.string(),
});

/**
 * The read's query input. `ok` is the DERIVED ledger column, not the sweep's claim.
 * `liar`, `blind`, and `missingField` select STORED evidence without changing rollups.
 * `missing=true` selects the separate expected-roster absence view. An ISO `since` or a
 * relative m/h/d/w lookback is normalized to a canonical ISO string in the reader before
 * lexical SQLite comparison, keeping `T` on both sides of the comparison.
 */
export const ReadRunLedgerInputSchema = z
  .object({
    blind: z.enum(["true", "false"]).optional(),
    cursor: z.string().min(1).max(MAX_RUN_LEDGER_CURSOR_CHARS).optional(),
    liar: z.enum(["true", "false"]).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_RUN_LEDGER_PAGE_SIZE).default(50),
    missing: z.enum(["true", "false"]).optional(),
    missingField: z
      .enum(["checked", "errors", "expected_interval_ms", "produced", "queue_depth"])
      .optional(),
    ok: z.enum(["true", "false"]).optional(),
    since: z.union([RunLedgerTimestampSchema, RunLedgerRelativeSinceSchema]).optional(),
    unit: z.string().min(1).max(MAX_UNIT_CHARS).optional(),
    until: RunLedgerTimestampSchema.optional(),
  })
  .superRefine((input, context) => {
    if (
      input.since !== undefined &&
      input.until !== undefined &&
      relativeSinceMs(input.since) === null &&
      Date.parse(input.since) > Date.parse(input.until)
    ) {
      context.addIssue({
        code: "custom",
        message: "since must be before or equal to until",
        path: ["until"],
      });
    }

    if (
      input.missing === "true" &&
      (input.blind !== undefined ||
        input.cursor !== undefined ||
        input.liar !== undefined ||
        input.missingField !== undefined ||
        input.ok !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "missing=true cannot be combined with stored-row evidence filters or a cursor",
        path: ["missing"],
      });
    }
  });

export type ReadRunLedgerInput = z.infer<typeof ReadRunLedgerInputSchema>;
export type RunLedgerMissingRosterEntry = z.infer<typeof RunLedgerMissingRosterEntrySchema>;
export type RunLedgerRow = z.infer<typeof RunLedgerRowSchema>;
export type RunLedgerUnitRollup = z.infer<typeof RunLedgerUnitRollupSchema>;

export const RunLedgerPageSchema = z.object({
  available: z.boolean(),
  missingRoster: z.array(RunLedgerMissingRosterEntrySchema),
  nextCursor: z.string().nullable(),
  rollups: z.array(RunLedgerUnitRollupSchema),
  rows: z.array(RunLedgerRowSchema),
  totalCount: z.number().int().nonnegative(),
});

export type RunLedgerPage = z.infer<typeof RunLedgerPageSchema>;

/**
 * `read_run_ledger` → `GET /admin/telemetry/runs` (operationId `readRunLedger`).
 *
 * OPERATOR tier: the rows contain internal host-unit names and raw sweep summaries.
 * This read returns the raw page plus per-unit counts over the whole unit/time window.
 * Evidence filters narrow the page and `totalCount`, while rollups keep the denominator
 * stable. The counts name only stored shapes (`ok = 0`, claim-vs-derived contradiction,
 * and three NULL work counters); deciding what those facts mean belongs to the reader.
 */
export const readRunLedger = oc
  .route({
    method: "GET",
    operationId: "readRunLedger",
    path: "/admin/telemetry/runs",
    summary: "Read run-ledger rows and per-unit aggregates",
    tags: ["Admin"],
  })
  .input(ReadRunLedgerInputSchema)
  .output(RunLedgerPageSchema);

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
 *   - `selfAssertedOk` is what the summary CLAIMED, or `null` if it claimed nothing. Next
 *     to `runOk` it makes one curl enough to see a sweep contradicting itself.
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
      selfAssertedOk: z.boolean().nullable(),
      stored: z.boolean(),
    }),
  );

/** The `admin-telemetry` domain's ops, merged into the root contract by `./index.ts`. */
export const adminTelemetryContract = {
  read_run_ledger: readRunLedger,
  record_run: recordRun,
};
