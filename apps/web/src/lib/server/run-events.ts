import {
  MAX_RUN_DATABASE_COUNT,
  type ReadRunLedgerInput,
  type RunEventInput,
  type RunLedgerPage,
  type RunLedgerRow,
  type RunLedgerUnitRollup,
} from "@fluncle/contracts/orpc";
import { runLedgerWriters } from "@fluncle/registry";
import {
  DATABASE_OUTCOMES,
  type DatabaseOutcome,
  isDatabaseAccessClass,
  isDatabaseOperationId,
  normalizeDatabaseRelease,
} from "./database-observability";
import { resolveDatabaseOperationOwner } from "./database-operation-registry";
import { getTelemetryDb, retryRunEventInsert } from "./db";
import { logEvent } from "./log";
import { ApiError } from "./spotify";

export type RunGateState =
  | "active"
  | "admission-skipped"
  | "disabled"
  | "dry-run"
  | "forced"
  | "locked"
  | "paused";

export type RunSummaryStatus = "absent" | "malformed" | "not_object" | "parsed";

export const MANDATORY_SUMMARY_FIELDS = [
  "checked",
  "errors",
  "expected_interval_ms",
  "produced",
  "queue_depth",
] as const;

const GATE_SUPPRESSED_FIELDS = new Set<string>(["checked", "produced", "queue_depth"]);

const GATE_STATES_THAT_NEVER_LOOKED = new Set<string>([
  "admission-skipped",
  "disabled",
  "locked",
  "paused",
]);

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
  "admission-skipped",
  "disabled",
  "dry-run",
  "forced",
  "locked",
  "paused",
]);

const ADMISSION_SKIP_OUTCOMES = new Set<string>([
  "acquisition-unavailable",
  "containment-unavailable",
  "enforcement-not-active",
  "invalid-grant",
  "wait-expired",
]);

function validateAdmissionSkip(
  summary: Record<string, unknown>,
  gateState: null | RunGateState,
): void {
  if (gateState !== "admission-skipped") {
    return;
  }

  const outcome = summary.admissionOutcome;
  if (typeof outcome !== "string" || !ADMISSION_SKIP_OUTCOMES.has(outcome)) {
    reject("an admission-skipped run must carry a recognized admissionOutcome");
  }

  if (summary.payloadStarted !== false) {
    reject("an admission-skipped run must carry payloadStarted:false");
  }

  requireCount("admissionWaitMs", summary.admissionWaitMs);

  if (
    typeof summary.admissionYieldReason !== "string" ||
    summary.admissionYieldReason.length === 0
  ) {
    reject("an admission-skipped run must carry a non-empty admissionYieldReason");
  }
}

const RECOGNISED_KEYS = new Set<string>([
  ...COUNTER_FIELDS.flatMap((field) => field.spellings),
  ...CANONICAL_ERROR_SPELLINGS,
  ...DOMAIN_FAILED_SPELLINGS,
  ...LEGACY_ERROR_SPELLINGS,
  ...GATE_STATE_SPELLINGS,
  ...PAUSED_SPELLINGS,
  ...OK_SPELLINGS,
  "admissionOutcome",
  "admissionWaitMs",
  "admissionYieldReason",
  "budgetExhaustedFamilies",
  "converged",
  "oldestDebtAgeMs",
  "outcome",
  "payloadStarted",
]);

const MAX_UNRECOGNISED_FIELDS = 32;

const MAX_FIELD_NAME_CHARS = 64;

export type NormalizedRunSummary = {
  checked: null | number;
  errors: null | number;
  expectedIntervalMs: null | number;
  gateState: null | RunGateState;
  missingFields: string[];
  produced: null | number;
  queueDepth: null | number;
  selfAssertedOk: boolean | null;
  summaryStatus: RunSummaryStatus;
  unrecognisedFields: string[];
  vendorCalls: null | number;
};

function reject(message: string): never {
  throw new ApiError("invalid_run_summary", message, 400);
}

function requireCount(field: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    reject(
      `run summary field "${field}" must be a non-negative integer, got ${JSON.stringify(value)}`,
    );
  }

  return value;
}

type SummaryField =
  | { key: string; kind: "declared-unknown" }
  | { key: string; kind: "value"; value: unknown }
  | { kind: "absent" };

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

function readGateState(summary: Record<string, unknown>): null | RunGateState {
  const gate = readField(summary, "gate_state", GATE_STATE_SPELLINGS);
  const paused = readField(summary, "paused", PAUSED_SPELLINGS);

  if (gate.kind === "value" && paused.kind === "value") {
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

  const { selfAssertedOk, unreadableKey } = readSelfAssertedOk(summary);
  const gateState = readGateState(summary);
  validateAdmissionSkip(summary, gateState);
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

      if (
        field.kind === "absent" &&
        !suppressed &&
        (MANDATORY_SUMMARY_FIELDS as readonly string[]).includes(canonical)
      ) {
        missingFields.push(canonical);
      }

      continue;
    }

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

export function deriveRunOk(exitCode: number, errors: null | number): boolean {
  return exitCode === 0 && (errors ?? 0) === 0;
}

export function runEventId(parts: { startedAt: string; unit: string }): string {
  return `${parts.unit}:${parts.startedAt}`;
}

export function runDurationMs(startedAt: string, endedAt: string): null | number {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);

  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }

  return end - start;
}

const INSERT_COLUMNS = [
  "id",
  "access_class",
  "attempt_count",
  "batch_count",
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
  "operation_id",
  "outcome",
  "produced",
  "queue_depth",
  "release",
  "run_duration_ms",
  "self_asserted_ok",
  "summary_raw",
  "summary_status",
  "unit",
  "unrecognised_fields",
  "vendor_calls",
] as const;

export type RecordedRun = {
  id: string;
  inserted: number;
  missingFields: string[];
  runOk: boolean;
  selfAssertedOk: boolean | null;
  stored: boolean;
};

export async function insertRunEvent(input: RunEventInput): Promise<RecordedRun> {
  const summary = withRegisteredCronCadence(input.unit, normalizeRunSummary(input.summary_raw));
  const runOk = deriveRunOk(input.exit_code, summary.errors);
  const operation = resolveDatabaseOperationOwner(input.unit);
  const operationId =
    operation !== undefined && isDatabaseOperationId(operation.operationId)
      ? operation.operationId
      : null;
  const accessClass = operation?.accessClass ?? null;
  const outcome: DatabaseOutcome = runOk ? "success" : "failure";
  const release = normalizeDatabaseRelease(input.release);
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

  const result = await retryRunEventInsert(() =>
    db.execute({
      args: [
        id,
        accessClass,
        input.attempt_count ?? null,
        input.batch_count ?? null,
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
        operationId,
        outcome,
        summary.produced,
        summary.queueDepth,
        release,
        runDurationMs(input.started_at, input.ended_at),
        summary.selfAssertedOk === null ? null : Number(summary.selfAssertedOk),
        input.summary_raw === undefined || input.summary_raw === null
          ? null
          : jsonSafeLedgerText(input.summary_raw),
        summary.summaryStatus,
        input.unit,
        JSON.stringify(summary.unrecognisedFields),
        summary.vendorCalls,
      ],
      sql: `insert into run_events (${INSERT_COLUMNS.join(", ")})
        values (${INSERT_COLUMNS.map(() => "?").join(", ")})
        on conflict(id) do nothing`,
    }),
  );

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
  access_class: unknown;
  attempt_count: unknown;
  batch_count: unknown;
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
  operation_id: unknown;
  outcome: unknown;
  produced: unknown;
  queue_depth: unknown;
  release: unknown;
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

export function jsonSafeLedgerText(value: string): string {
  return value.replace(/[ -]/g, (character) => {
    const code = character.charCodeAt(0);

    return `\\u${code.toString(16).padStart(4, "0")}`;
  });
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

function nullableLedgerCount(value: unknown, field: string): number | null {
  const count = nullableLedgerNumber(value, field);

  if (count !== null && (!Number.isInteger(count) || count < 0 || count > MAX_RUN_DATABASE_COUNT)) {
    throw new Error(`run_events.${field} was not a bounded non-negative integer`);
  }

  return count;
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

function nullableLedgerAccessClass(value: unknown) {
  if (value === null) {
    return null;
  }

  if (!isDatabaseAccessClass(value)) {
    throw new Error("run_events.access_class was not a known database access class");
  }

  return value;
}

function nullableLedgerOperationId(value: unknown): string | null {
  if (value === null) {
    return null;
  }

  if (!isDatabaseOperationId(value)) {
    throw new Error("run_events.operation_id was not a bounded database operation id");
  }

  return value;
}

function ledgerOutcome(value: unknown, ok: boolean): DatabaseOutcome {
  if (value === null) {
    return ok ? "success" : "failure";
  }

  if (typeof value !== "string" || !(DATABASE_OUTCOMES as readonly string[]).includes(value)) {
    throw new Error("run_events.outcome was not a known database outcome");
  }

  return value as DatabaseOutcome;
}

function ledgerRelease(value: unknown): string {
  const release = ledgerText(value, "release");

  if (normalizeDatabaseRelease(release) !== release) {
    throw new Error("run_events.release was not a bounded database release");
  }

  return release;
}

function toRunLedgerRow(row: RunLedgerDbRow): RunLedgerRow {
  const ok = ledgerBoolean(row.ok, "ok");

  return {
    accessClass: nullableLedgerAccessClass(row.access_class),
    attemptCount: nullableLedgerCount(row.attempt_count, "attempt_count"),
    batchCount: nullableLedgerCount(row.batch_count, "batch_count"),
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
    ok,
    operationId: nullableLedgerOperationId(row.operation_id),
    outcome: ledgerOutcome(row.outcome, ok),
    produced: nullableLedgerNumber(row.produced, "produced"),
    queueDepth: nullableLedgerNumber(row.queue_depth, "queue_depth"),
    release: ledgerRelease(row.release),
    runDurationMs: nullableLedgerNumber(row.run_duration_ms, "run_duration_ms"),
    selfAssertedOk: nullableLedgerBoolean(row.self_asserted_ok, "self_asserted_ok"),
    summaryRaw:
      row.summary_raw === null
        ? null
        : jsonSafeLedgerText(ledgerText(row.summary_raw, "summary_raw")),
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
  } catch {}

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
                   access_class, attempt_count, batch_count, expected_interval_ms,
                   gate_state, id, missing_fields, occurred_at, ok, operation_id,
                   outcome, produced, queue_depth, release, run_duration_ms,
                   self_asserted_ok, summary_raw, summary_status, unit,
                   unrecognised_fields, vendor_calls
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
