import { oc } from "@orpc/contract";
import * as z from "zod";

const MAX_UNIT_CHARS = 128;

const MAX_TIMESTAMP_CHARS = 64;
const MAX_RUN_RELEASE_CHARS = 64;
const RUN_OPERATION_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const RUN_RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const MAX_RUN_DATABASE_COUNT = 1_000_000;

const RunDatabaseAccessClassSchema = z.enum(["heavy-read", "read", "write"]);
const RunDatabaseOutcomeSchema = z.enum(["failure", "success"]);

export const MAX_RUN_LEDGER_PAGE_SIZE = 100;

const MAX_RUN_LEDGER_CURSOR_CHARS = 512;

export const MAX_SUMMARY_RAW_CHARS = 4096;

export const RunEventInputSchema = z
  .strictObject({
    attempt_count: z.number().int().nonnegative().max(MAX_RUN_DATABASE_COUNT).nullish(),

    batch_count: z.number().int().nonnegative().max(MAX_RUN_DATABASE_COUNT).nullish(),

    ended_at: z.string().min(1).max(MAX_TIMESTAMP_CHARS),

    exit_code: z.number().int().min(0).max(255),

    release: z.string().min(1).max(MAX_RUN_RELEASE_CHARS).regex(RUN_RELEASE_PATTERN).nullish(),

    started_at: z.string().min(1).max(MAX_TIMESTAMP_CHARS),

    summary_raw: z.string().max(MAX_SUMMARY_RAW_CHARS).nullish(),

    unit: z.string().min(1).max(MAX_UNIT_CHARS),
  })
  .meta({ id: "RunEventInput" });

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

export const RunLedgerUnitRollupSchema = z.object({
  blindCount: z.number().int().nonnegative(),
  expectedIntervalMs: z.number().int().nullable(),
  failedCount: z.number().int().nonnegative(),
  lastOccurredAt: z.string(),
  liarCount: z.number().int().nonnegative(),
  runCount: z.number().int().nonnegative(),
  unit: z.string(),
});

export const RunLedgerMissingRosterEntrySchema = z.object({
  expectedIntervalMs: z.number().int().positive(),
  unit: z.string(),
});

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

export const adminTelemetryContract = {
  read_run_ledger: readRunLedger,
  record_run: recordRun,
};
