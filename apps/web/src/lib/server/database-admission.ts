import { type Client } from "@libsql/client";
import { logEvent } from "./log";
import { DATABASE_OPERATION_ID_MAX_LENGTH } from "./database-observability";
import { resolveDatabaseOperationOwner } from "./database-operation-registry";

export const DATABASE_ADMISSION_LEASE_MS = 90_000;
export const DATABASE_ADMISSION_HEARTBEAT_MS = 30_000;
export const DATABASE_ADMISSION_QUEUE_TTL_MS = 60_000;
export const DATABASE_ADMISSION_QUEUE_REFRESH_MS = 20_000;
export const DATABASE_ADMISSION_STALL_TOLERANT_PROTOCOL = 2;
export const DATABASE_ADMISSION_INITIAL_LEASE_MS = 45_000;
export const DATABASE_ADMISSION_RENEWED_LEASE_MS = 420_000;
export const DATABASE_ADMISSION_MIN_HEARTBEAT_MS = 1_000;
export const DATABASE_ADMISSION_HEAD_RETRY_AFTER_MS = 2_000;
export const DATABASE_ADMISSION_DIRECT_READ_RETRY_AFTER_MS = 5_000;
export const DATABASE_ADMISSION_MAX_RETRY_AFTER_MS = 15_000;
export const DATABASE_ADMISSION_HEALTH_STALE_MS = 20 * 60 * 1000;
export const DATABASE_ADMISSION_HEALTH_BAD_STREAK = 2;
export const DATABASE_ADMISSION_DIRECT_READ_LIMIT_MS = 250;
export const DATABASE_ADMISSION_PUBLIC_LATENCY_LIMIT_MS = 500;
export const DATABASE_ADMISSION_ENFORCED_KEY = "database_admission_enforced";
export const DATABASE_ADMISSION_STORE_KEY = "database_admission_store";
export const DATABASE_ADMISSION_STORE_EPOCH_KEY = "database_admission_store_epoch";
export const DATABASE_ADMISSION_PRIMARY_READ_TIMEOUT_MS = 2_000;
export const DATABASE_WRITE_PROBE_KEY = "database_write_probe";
export const DATABASE_WRITE_PROBE_TIMEOUT_MS = 5_000;
export const DATABASE_WRITE_PROBE_SLOW_MS = 1_000;
export const DATABASE_WRITE_PROBE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DATABASE_WRITE_PROBE_PRUNE_LIMIT = 100;
export const DATABASE_ADMISSION_TRANSACTION_RETRIES = 12;
export const DATABASE_ADMISSION_RECOVERY_LIMIT = 128;

export type DatabaseAdmissionAction = "acquire" | "cancel" | "heartbeat" | "release";
export type DatabaseAdmissionLane = "heavy-read" | "write";
export type DatabaseAdmissionOutcome =
  | "acquired"
  | "cancelled"
  | "lost"
  | "queued"
  | "released"
  | "shadow-acquire"
  | "shadow-yield";
export type DatabaseAdmissionYieldReason =
  | "database-health"
  | "direct-read-latency"
  | "public-latency"
  | "queue"
  | "write-latency";

export type DatabaseAdmissionStoreKind = "primary" | "telemetry";

export type DatabaseAdmissionStoreRoute = Readonly<{
  epoch: number | null;
  store: DatabaseAdmissionStoreKind;
}>;

export type DatabaseWriteProbeOutcome = "failed" | "ok" | "slow" | "stalled";

export type DatabaseWriteProbeResult = Readonly<{
  latencyMs: number | null;
  outcome: DatabaseWriteProbeOutcome;
  recorded: boolean;
}>;

export type DatabaseAdmissionRequest = Readonly<{
  action: DatabaseAdmissionAction;
  fencingToken?: number;
  notAfterMs?: number;
  owner: string;
  protocolVersion?: typeof DATABASE_ADMISSION_STALL_TOLERANT_PROTOCOL;
  runId: string;
}>;

export type DatabaseAdmissionResult = Readonly<{
  contenderId: string;
  enforced: boolean;
  fencingToken: number | null;
  heavyRead: boolean;
  heartbeatAfterMs: number;
  holdMs: number;
  lane: DatabaseAdmissionLane;
  leaseExpiresAtMs: number | null;
  leaseRemainingMs: number | null;
  operationId: string;
  outcome: DatabaseAdmissionOutcome;
  queueAgeMs: number;
  recovered: boolean;
  retryAfterMs: number | null;
  waitMs: number;
  yieldReason: DatabaseAdmissionYieldReason | null;
}>;

type AdmissionClient = Pick<Client, "batch" | "execute">;

export type DatabaseAdmissionStores = Readonly<{
  primary: AdmissionClient;
  telemetry?: AdmissionClient;
}>;

type LeaseStore = Readonly<{
  client: AdmissionClient;
  gate: SqlPredicate;
  kind: DatabaseAdmissionStoreKind;
  tokenFloors: Readonly<Record<DatabaseAdmissionLane, number>>;
}>;

type GuardrailSources = Readonly<{
  lease: AdmissionClient;
  primary: AdmissionClient;
  probes?: AdmissionClient;
}>;

type AdmissionDependencies = Readonly<{
  databaseNowMs?: () => number;
  monotonicNow?: () => number;
  primaryReadTimeoutMs?: number;
  serverNowMs?: number;
  wait?: (delayMs: number) => Promise<void>;
}>;

export type HealthSampleRow = Readonly<{
  latency_ms: number | null;
  service: string;
  status: string;
}>;

type QueueRow = Readonly<{
  active_count: number;
  oldest_enqueued_at_ms: number | null;
  queued_count: number;
}>;

type ContenderRow = Readonly<{
  acquired_at_ms: number | null;
  contender_id: string;
  enqueued_at_ms: number;
  fencing_token: number | null;
  lease_expires_at_ms: number | null;
  operation_id: string;
  queue_heartbeat_at_ms: number;
  state: "active" | "queued";
}>;

type QueuePosition = ContenderRow &
  Readonly<{
    active_conflict_count: number;
    ahead_count: number;
  }>;

type ClockObservation = Readonly<{
  directReadSlow: boolean;
  nowMs: number;
}>;

type AcquisitionGuardrails = Readonly<{
  nowMs: number;
  reason: DatabaseAdmissionYieldReason | null;
  storedHealthBlocked: boolean;
}>;

type AdmissionResourceProfile = Readonly<{
  heavyRead: boolean;
  lane: DatabaseAdmissionLane;
  operationId: string;
}>;

type SqlPredicate = Readonly<{
  args: readonly (number | string)[];
  sql: string;
}>;

type SqlStatement = { args: (number | string)[]; sql: string };

const HEAVY_READER_OPERATION_SUFFIX = "|heavy-read";
const HEALTH_SNAPSHOT_OPERATION_ID = "health.snapshot";

function boundedDuration(value: number): number {
  return Math.max(0, Math.round(value));
}

export function isDatabaseBusy(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === "SQLITE_BUSY"
  );
}

function waitFor(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isStallTolerant(request: DatabaseAdmissionRequest): boolean {
  return request.protocolVersion === DATABASE_ADMISSION_STALL_TOLERANT_PROTOCOL;
}

function grantedLeaseMs(request: DatabaseAdmissionRequest): number {
  return isStallTolerant(request)
    ? DATABASE_ADMISSION_INITIAL_LEASE_MS
    : DATABASE_ADMISSION_LEASE_MS;
}

function renewedLeaseMs(request: DatabaseAdmissionRequest): number {
  return isStallTolerant(request)
    ? DATABASE_ADMISSION_RENEWED_LEASE_MS
    : DATABASE_ADMISSION_LEASE_MS;
}

function resourceProfileForOwner(owner: string): AdmissionResourceProfile {
  const operation = resolveDatabaseOperationOwner(owner);
  if (operation?.accessClass === "write") {
    return {
      heavyRead: operation.heavyRead,
      lane: "write",
      operationId: operation.operationId,
    };
  }
  if (operation?.accessClass === "heavy-read" && operation.heavy) {
    return { heavyRead: true, lane: "heavy-read", operationId: operation.operationId };
  }

  throw new Error(`database admission owner is not a classified writer or heavy reader: ${owner}`);
}

function isHealthSnapshotWriter(profile: AdmissionResourceProfile): boolean {
  return profile.operationId === HEALTH_SNAPSHOT_OPERATION_ID;
}

function conflictingResourcePredicate(
  profile: AdmissionResourceProfile,
  tableAlias?: string,
): SqlPredicate {
  const column = (name: string) => (tableAlias === undefined ? name : `${tableAlias}.${name}`);
  if (profile.lane === "write" && profile.heavyRead) {
    return { args: [], sql: `${column("lane")} in ('write', 'heavy-read')` };
  }
  if (profile.lane === "write") {
    return { args: [], sql: `${column("lane")} = 'write'` };
  }
  return {
    args: [`*${HEAVY_READER_OPERATION_SUFFIX}`],
    sql: `(${column("lane")} = 'heavy-read' or (${column("lane")} = 'write' and ${column("operation_id")} glob ?))`,
  };
}

function persistedOperationId(profile: AdmissionResourceProfile): string {
  const operationId =
    profile.lane === "write" && profile.heavyRead
      ? `${profile.operationId}${HEAVY_READER_OPERATION_SUFFIX}`
      : profile.operationId;
  if (operationId.length > DATABASE_OPERATION_ID_MAX_LENGTH) {
    throw new Error(
      `database admission operation id exceeds persisted bounds: ${profile.operationId}`,
    );
  }
  return operationId;
}

function queuedResourcePredicate(
  profile: AdmissionResourceProfile,
  storedHealthBlocked: boolean,
  tableAlias?: string,
): SqlPredicate {
  const conflict = conflictingResourcePredicate(profile, tableAlias);
  if (!isHealthSnapshotWriter(profile)) {
    return conflict;
  }
  const operationId = tableAlias === undefined ? "operation_id" : `${tableAlias}.operation_id`;
  return {
    args: [
      ...conflict.args,
      HEALTH_SNAPSHOT_OPERATION_ID,
      `${HEALTH_SNAPSHOT_OPERATION_ID}${HEAVY_READER_OPERATION_SUFFIX}`,
      storedHealthBlocked ? 1 : 0,
    ],
    sql: `(${conflict.sql}) and (${operationId} in (?, ?) or ? = 0)`,
  };
}

function rowNumber(value: unknown): number | null {
  return typeof value === "number" || typeof value === "bigint" ? Number(value) : null;
}

function isBadHealthSample(sample: HealthSampleRow): boolean {
  if (sample.status !== "ok") {
    return true;
  }
  return (
    sample.service === "web" &&
    sample.latency_ms !== null &&
    sample.latency_ms > DATABASE_ADMISSION_PUBLIC_LATENCY_LIMIT_MS
  );
}

export function storedHealthReasonFromSamples(
  newestFirstFreshSamples: readonly HealthSampleRow[],
): DatabaseAdmissionYieldReason | null {
  const consecutivelyBad = (service: string) => {
    const newest = newestFirstFreshSamples
      .filter((sample) => sample.service === service)
      .slice(0, DATABASE_ADMISSION_HEALTH_BAD_STREAK);
    return (
      newest.length === DATABASE_ADMISSION_HEALTH_BAD_STREAK && newest.every(isBadHealthSample)
    );
  };

  if (consecutivelyBad("db")) {
    return "database-health";
  }
  if (consecutivelyBad("web")) {
    return "public-latency";
  }
  return null;
}

type Deadline<T> = Readonly<{ settled: true; value: T }> | Readonly<{ settled: false }>;

function withinDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<Deadline<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ settled: false }), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve({ settled: true, value });
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function injectedNowMs(dependencies: AdmissionDependencies): number | null {
  return dependencies.databaseNowMs?.() ?? dependencies.serverNowMs ?? null;
}

function primaryReadTimeoutMs(dependencies: AdmissionDependencies): number {
  return dependencies.primaryReadTimeoutMs ?? DATABASE_ADMISSION_PRIMARY_READ_TIMEOUT_MS;
}

function isBadWriteProbe(outcome: unknown): boolean {
  return outcome !== "ok";
}

export function writeProbeReasonFromSamples(
  newestFirstFreshOutcomes: readonly string[],
): DatabaseAdmissionYieldReason | null {
  const newest = newestFirstFreshOutcomes.slice(0, DATABASE_ADMISSION_HEALTH_BAD_STREAK);
  return newest.length === DATABASE_ADMISSION_HEALTH_BAD_STREAK && newest.every(isBadWriteProbe)
    ? "write-latency"
    : null;
}

async function readStoredHealthReason(
  client: AdmissionClient,
  nowMs: number,
): Promise<DatabaseAdmissionYieldReason | null> {
  const freshSince = new Date(
    Math.max(0, nowMs - DATABASE_ADMISSION_HEALTH_STALE_MS),
  ).toISOString();
  const result = await client.execute({
    args: [
      freshSince,
      DATABASE_ADMISSION_HEALTH_BAD_STREAK,
      freshSince,
      DATABASE_ADMISSION_HEALTH_BAD_STREAK,
    ],
    sql: `select service, status, latency_ms from (
            select service, status, latency_ms from service_check_samples
            where service = 'db' and at >= ?
            order by at desc, id desc limit ?
          )
          union all
          select service, status, latency_ms from (
            select service, status, latency_ms from service_check_samples
            where service = 'web' and at >= ?
            order by at desc, id desc limit ?
          )`,
  });
  const samples = result.rows.flatMap((row): HealthSampleRow[] => {
    if (typeof row.service !== "string" || typeof row.status !== "string") {
      return [];
    }
    return [{ latency_ms: rowNumber(row.latency_ms), service: row.service, status: row.status }];
  });
  return storedHealthReasonFromSamples(samples);
}

async function readWriteProbeReason(
  client: AdmissionClient,
  nowMs: number,
): Promise<DatabaseAdmissionYieldReason | null> {
  const result = await client.execute({
    args: [nowMs - DATABASE_ADMISSION_HEALTH_STALE_MS, DATABASE_ADMISSION_HEALTH_BAD_STREAK],
    sql: `select outcome from database_write_probes
          where observed_at_ms >= ?
          order by observed_at_ms desc, id desc limit ?`,
  });
  return writeProbeReasonFromSamples(
    result.rows.flatMap((row) => (typeof row.outcome === "string" ? [row.outcome] : [])),
  );
}

async function observeStoredGuardrails(
  sources: GuardrailSources,
  nowMs: number,
  dependencies: AdmissionDependencies,
): Promise<DatabaseAdmissionYieldReason | null> {
  const [health, write] = await Promise.all([
    withinDeadline(
      readStoredHealthReason(sources.primary, nowMs).catch(() => null),
      primaryReadTimeoutMs(dependencies),
    ),
    sources.probes === undefined
      ? Promise.resolve({ settled: true, value: null } as const)
      : withinDeadline(
          readWriteProbeReason(sources.probes, nowMs).catch(() => null),
          primaryReadTimeoutMs(dependencies),
        ),
  ]);
  return (health.settled ? health.value : null) ?? (write.settled ? write.value : null);
}

const DATABASE_CLOCK_SQL = `select cast(unixepoch('subsec') * 1000 as integer) as now_ms`;

async function readStoreClock(
  client: AdmissionClient,
  dependencies: AdmissionDependencies,
): Promise<number> {
  const injected = injectedNowMs(dependencies);
  if (injected !== null) {
    return injected;
  }
  const clock = await client.execute(DATABASE_CLOCK_SQL);
  const nowMs = rowNumber(clock.rows[0]?.now_ms);
  if (nowMs === null) {
    throw new Error("database admission could not read the database clock");
  }
  return nowMs;
}

async function probePrimaryRead(
  primary: AdmissionClient,
  dependencies: AdmissionDependencies,
): Promise<boolean> {
  const monotonicNow = dependencies.monotonicNow ?? performance.now.bind(performance);
  const startedAt = monotonicNow();
  const probe = await withinDeadline(
    primary.execute("select 1 as ok").then(
      () => true,
      () => false,
    ),
    primaryReadTimeoutMs(dependencies),
  );
  const latencyMs = boundedDuration(monotonicNow() - startedAt);
  return !probe.settled || !probe.value || latencyMs > DATABASE_ADMISSION_DIRECT_READ_LIMIT_MS;
}

async function observeClock(
  sources: GuardrailSources,
  dependencies: AdmissionDependencies,
): Promise<ClockObservation> {
  if (sources.lease !== sources.primary) {
    const [nowMs, directReadSlow] = await Promise.all([
      readStoreClock(sources.lease, dependencies),
      probePrimaryRead(sources.primary, dependencies),
    ]);
    return { directReadSlow, nowMs };
  }
  const monotonicNow = dependencies.monotonicNow ?? performance.now.bind(performance);
  const startedAt = monotonicNow();
  const clock = await sources.primary.execute(DATABASE_CLOCK_SQL);
  const directReadLatencyMs = boundedDuration(monotonicNow() - startedAt);
  const databaseNowMs = rowNumber(clock.rows[0]?.now_ms);
  const nowMs = injectedNowMs(dependencies) ?? databaseNowMs;
  if (nowMs === null) {
    throw new Error("database admission could not read the database clock");
  }

  return {
    directReadSlow: directReadLatencyMs > DATABASE_ADMISSION_DIRECT_READ_LIMIT_MS,
    nowMs,
  };
}

async function observeAcquisitionGuardrails(
  sources: GuardrailSources,
  profile: AdmissionResourceProfile,
  dependencies: AdmissionDependencies,
): Promise<AcquisitionGuardrails> {
  const clock = await observeClock(sources, dependencies);
  const storedHealthReason = await observeStoredGuardrails(sources, clock.nowMs, dependencies);
  const storedHealthBlocked = storedHealthReason !== null;
  if (clock.directReadSlow) {
    return { nowMs: clock.nowMs, reason: "direct-read-latency", storedHealthBlocked };
  }
  return {
    nowMs: clock.nowMs,
    reason: isHealthSnapshotWriter(profile) ? null : storedHealthReason,
    storedHealthBlocked,
  };
}

function emitAdmissionTelemetry(
  request: DatabaseAdmissionRequest,
  result: DatabaseAdmissionResult,
  store: DatabaseAdmissionStoreKind = "primary",
): void {
  logEvent("info", "database.admission", {
    access_class: result.lane,
    contender: result.contenderId,
    enforced: result.enforced,
    heavy_read: result.heavyRead,
    hold_ms: result.holdMs,
    operation_id: result.operationId,
    outcome: result.outcome,
    owner: request.owner,
    queue_age_ms: result.queueAgeMs,
    recovered: result.recovered,
    run_id: request.runId,
    store,
    wait_ms: result.waitMs,
    yield_reason: result.yieldReason,
  });
}

function contenderRow(row: Record<string, unknown> | undefined): ContenderRow | undefined {
  if (
    row === undefined ||
    typeof row.contender_id !== "string" ||
    typeof row.operation_id !== "string" ||
    (row.state !== "active" && row.state !== "queued")
  ) {
    return undefined;
  }
  const enqueuedAtMs = rowNumber(row.enqueued_at_ms);
  if (enqueuedAtMs === null) {
    return undefined;
  }
  return {
    acquired_at_ms: rowNumber(row.acquired_at_ms),
    contender_id: row.contender_id,
    enqueued_at_ms: enqueuedAtMs,
    fencing_token: rowNumber(row.fencing_token),
    lease_expires_at_ms: rowNumber(row.lease_expires_at_ms),
    operation_id: row.operation_id,
    queue_heartbeat_at_ms: rowNumber(row.queue_heartbeat_at_ms) ?? enqueuedAtMs,
    state: row.state,
  };
}

function queuePosition(row: Record<string, unknown> | undefined): QueuePosition | undefined {
  const contender = contenderRow(row);
  if (contender === undefined) {
    return undefined;
  }
  return {
    ...contender,
    active_conflict_count: rowNumber(row?.active_conflict_count) ?? 0,
    ahead_count: rowNumber(row?.ahead_count) ?? 0,
  };
}

function leaseRemainingMs(contender: ContenderRow | undefined, nowMs: number): number | null {
  if (contender?.state !== "active" || contender.lease_expires_at_ms === null) {
    return null;
  }
  return boundedDuration(contender.lease_expires_at_ms - nowMs);
}

function heartbeatAfterMs(remainingMs: number | null): number {
  if (remainingMs === null) {
    return DATABASE_ADMISSION_HEARTBEAT_MS;
  }
  return Math.max(
    DATABASE_ADMISSION_MIN_HEARTBEAT_MS,
    Math.min(DATABASE_ADMISSION_HEARTBEAT_MS, Math.floor(remainingMs / 3)),
  );
}

export function suggestedRetryAfterMs(
  yieldReason: DatabaseAdmissionYieldReason,
  aheadCount: number,
): number {
  if (
    yieldReason === "database-health" ||
    yieldReason === "public-latency" ||
    yieldReason === "write-latency"
  ) {
    return DATABASE_ADMISSION_MAX_RETRY_AFTER_MS;
  }
  if (yieldReason === "direct-read-latency") {
    return DATABASE_ADMISSION_DIRECT_READ_RETRY_AFTER_MS;
  }
  return Math.min(
    DATABASE_ADMISSION_MAX_RETRY_AFTER_MS,
    DATABASE_ADMISSION_HEAD_RETRY_AFTER_MS * (Math.max(0, aheadCount) + 1),
  );
}

function enforcedResult(
  request: DatabaseAdmissionRequest,
  profile: AdmissionResourceProfile,
  options: {
    aheadCount?: number;
    contender?: ContenderRow;
    nowMs: number;
    outcome: Exclude<DatabaseAdmissionOutcome, "shadow-acquire" | "shadow-yield">;
    recovered?: boolean;
    yieldReason?: DatabaseAdmissionYieldReason | null;
  },
): DatabaseAdmissionResult {
  const acquiredAtMs = options.contender?.acquired_at_ms;
  const queueAgeMs = boundedDuration(
    options.nowMs - (options.contender?.enqueued_at_ms ?? options.nowMs),
  );
  const remainingMs =
    options.outcome === "acquired" ? leaseRemainingMs(options.contender, options.nowMs) : null;
  const yieldReason = options.yieldReason ?? null;
  return {
    contenderId: `${request.owner}:${request.runId}`,
    enforced: true,
    fencingToken: options.contender?.fencing_token ?? null,
    heartbeatAfterMs: heartbeatAfterMs(remainingMs),
    heavyRead:
      profile.heavyRead ||
      options.contender?.operation_id.endsWith(HEAVY_READER_OPERATION_SUFFIX) === true,
    holdMs:
      acquiredAtMs === null || acquiredAtMs === undefined
        ? 0
        : boundedDuration(options.nowMs - acquiredAtMs),
    lane: profile.lane,
    leaseExpiresAtMs: options.contender?.lease_expires_at_ms ?? null,
    leaseRemainingMs: remainingMs,
    operationId: profile.operationId,
    outcome: options.outcome,
    queueAgeMs,
    recovered: options.recovered ?? false,
    retryAfterMs:
      options.outcome === "queued" && yieldReason !== null
        ? suggestedRetryAfterMs(yieldReason, options.aheadCount ?? 0)
        : null,
    waitMs: queueAgeMs,
    yieldReason,
  };
}

async function readContender(
  client: AdmissionClient,
  owner: string,
  runId: string,
): Promise<ContenderRow | undefined> {
  const result = await client.execute({
    args: [owner, runId],
    sql: `select contender_id, state, enqueued_at_ms, acquired_at_ms, fencing_token, operation_id,
                 lease_expires_at_ms, queue_heartbeat_at_ms
            from database_admission_contenders
            where owner_id = ? and run_id = ?
            limit 1`,
  });
  return contenderRow(result.rows[0]);
}

function queuePositionStatement(
  request: DatabaseAdmissionRequest,
  profile: AdmissionResourceProfile,
  guardrails: AcquisitionGuardrails,
): SqlStatement {
  const ahead = queuedResourcePredicate(profile, guardrails.storedHealthBlocked, "other");
  const holders = conflictingResourcePredicate(profile, "holder");
  return {
    args: [
      ...ahead.args,
      guardrails.nowMs - DATABASE_ADMISSION_QUEUE_TTL_MS,
      ...holders.args,
      guardrails.nowMs,
      request.owner,
      request.runId,
    ],
    sql: `select c.contender_id, c.state, c.enqueued_at_ms, c.acquired_at_ms, c.fencing_token,
                 c.operation_id, c.lease_expires_at_ms, c.queue_heartbeat_at_ms,
                 (select count(*) from database_admission_contenders as other
                   where ${ahead.sql} and other.state = 'queued'
                     and other.queue_heartbeat_at_ms > ?
                     and (other.enqueued_at_ms < c.enqueued_at_ms
                       or (other.enqueued_at_ms = c.enqueued_at_ms
                         and other.contender_id < c.contender_id))) as ahead_count,
                 (select count(*) from database_admission_contenders as holder
                   where ${holders.sql} and holder.state = 'active'
                     and holder.lease_expires_at_ms > ?
                     and holder.contender_id != c.contender_id) as active_conflict_count
            from database_admission_contenders as c
            where c.owner_id = ? and c.run_id = ?
            limit 1`,
  };
}

function waitsWithoutWriting(position: QueuePosition, guardrails: AcquisitionGuardrails): boolean {
  return (
    position.state === "queued" &&
    guardrails.nowMs - position.queue_heartbeat_at_ms < DATABASE_ADMISSION_QUEUE_REFRESH_MS &&
    (guardrails.reason !== null || position.active_conflict_count > 0 || position.ahead_count > 0)
  );
}

function holdsUnexpiredGrant(position: QueuePosition, nowMs: number): boolean {
  return (
    position.state === "active" &&
    position.lease_expires_at_ms !== null &&
    position.lease_expires_at_ms > nowMs
  );
}

async function abandonLateAcquisition(
  client: AdmissionClient,
  request: DatabaseAdmissionRequest,
  profile: AdmissionResourceProfile,
  nowMs: number,
): Promise<DatabaseAdmissionResult> {
  const existing = await readContender(client, request.owner, request.runId);
  if (
    existing?.state === "active" &&
    existing.lease_expires_at_ms !== null &&
    existing.lease_expires_at_ms > nowMs
  ) {
    return enforcedResult(request, profile, { contender: existing, nowMs, outcome: "acquired" });
  }
  const abandoned = await client.execute({
    args: [request.owner, request.runId, nowMs],
    sql: `delete from database_admission_contenders
          where owner_id = ? and run_id = ?
            and (state = 'queued' or lease_expires_at_ms <= ?)`,
  });
  return enforcedResult(request, profile, {
    nowMs,
    outcome: "cancelled",
    recovered: abandoned.rowsAffected > 0,
    yieldReason: "queue",
  });
}

async function acquireEnforcedDatabaseAdmissionFor(
  store: LeaseStore,
  request: DatabaseAdmissionRequest,
  profile: AdmissionResourceProfile,
  guardrails: AcquisitionGuardrails,
): Promise<DatabaseAdmissionResult> {
  const { client } = store;
  if (request.notAfterMs !== undefined && guardrails.nowMs > request.notAfterMs) {
    return abandonLateAcquisition(client, request, profile, guardrails.nowMs);
  }

  const before = queuePosition(
    (await client.execute(queuePositionStatement(request, profile, guardrails))).rows[0],
  );
  if (before !== undefined && holdsUnexpiredGrant(before, guardrails.nowMs)) {
    return enforcedResult(request, profile, {
      contender: before,
      nowMs: guardrails.nowMs,
      outcome: "acquired",
    });
  }
  if (before !== undefined && waitsWithoutWriting(before, guardrails)) {
    return enforcedResult(request, profile, {
      aheadCount: before.ahead_count,
      contender: before,
      nowMs: guardrails.nowMs,
      outcome: "queued",
      yieldReason: guardrails.reason ?? "queue",
    });
  }

  const contenderId = `${request.owner}:${request.runId}`;
  const staleQueueBeforeMs = guardrails.nowMs - DATABASE_ADMISSION_QUEUE_TTL_MS;
  const mayAcquire = guardrails.reason === null ? 1 : 0;
  const leaseExpiresAtMs = guardrails.nowMs + grantedLeaseMs(request);
  const conflict = conflictingResourcePredicate(profile);
  const queuedResource = queuedResourcePredicate(profile, guardrails.storedHealthBlocked);
  const results = await client.batch(
    [
      {
        args: [staleQueueBeforeMs, DATABASE_ADMISSION_RECOVERY_LIMIT],
        sql: `delete from database_admission_contenders
              where contender_id in (
                select contender_id from database_admission_contenders
                where state = 'queued' and queue_heartbeat_at_ms <= ?
                order by queue_heartbeat_at_ms asc, contender_id asc
                limit ?
              )`,
      },
      {
        args: [guardrails.nowMs, DATABASE_ADMISSION_RECOVERY_LIMIT],
        sql: `delete from database_admission_contenders
              where contender_id in (
                select contender_id from database_admission_contenders
                where state = 'active' and lease_expires_at_ms <= ?
                order by lease_expires_at_ms asc, contender_id asc
                limit ?
              )`,
      },
      {
        args: [profile.lane, store.tokenFloors[profile.lane], guardrails.nowMs],
        sql: `insert into database_admission_lanes (lane, next_fencing_token, updated_at_ms)
              values (?, ?, ?)
              on conflict(lane) do update set
                next_fencing_token = excluded.next_fencing_token,
                updated_at_ms = excluded.updated_at_ms
              where excluded.next_fencing_token > database_admission_lanes.next_fencing_token`,
      },
      {
        args: [
          contenderId,
          profile.lane,
          persistedOperationId(profile),
          request.owner,
          request.runId,
          guardrails.nowMs,
          guardrails.nowMs,
          guardrails.nowMs,
          guardrails.nowMs,
          guardrails.nowMs,
        ],
        sql: `insert into database_admission_contenders
              (contender_id, lane, operation_id, owner_id, run_id, state, enqueued_at_ms,
               queue_heartbeat_at_ms, updated_at_ms)
              values (?, ?, ?, ?, ?, 'queued', ?, ?, ?)
              on conflict(owner_id, run_id) do update set
                queue_heartbeat_at_ms = ?, updated_at_ms = ?
              where database_admission_contenders.state = 'queued'`,
      },
      {
        args: [
          guardrails.nowMs,
          profile.lane,
          mayAcquire,
          ...store.gate.args,
          ...conflict.args,
          contenderId,
          ...queuedResource.args,
        ],
        sql: `update database_admission_lanes
              set next_fencing_token = next_fencing_token + 1, updated_at_ms = ?
              where lane = ? and ? = 1 and ${store.gate.sql}
                and not exists (
                  select 1 from database_admission_contenders
                  where ${conflict.sql} and state = 'active'
                )
                and ? = (
                  select contender_id from database_admission_contenders
                  where ${queuedResource.sql} and state = 'queued'
                  order by enqueued_at_ms asc, contender_id asc limit 1
                )`,
      },
      {
        args: [
          guardrails.nowMs,
          profile.lane,
          leaseExpiresAtMs,
          guardrails.nowMs,
          contenderId,
          mayAcquire,
          ...store.gate.args,
          ...conflict.args,
          ...queuedResource.args,
        ],
        sql: `update database_admission_contenders
              set state = 'active', acquired_at_ms = ?,
                  fencing_token = (select next_fencing_token from database_admission_lanes where lane = ?),
                  lease_expires_at_ms = ?, updated_at_ms = ?
              where contender_id = ? and state = 'queued' and ? = 1 and ${store.gate.sql}
                and not exists (
                  select 1 from database_admission_contenders
                  where ${conflict.sql} and state = 'active'
                )
                and contender_id = (
                  select contender_id from database_admission_contenders
                  where ${queuedResource.sql} and state = 'queued'
                  order by enqueued_at_ms asc, contender_id asc limit 1
                )`,
      },
      queuePositionStatement(request, profile, guardrails),
    ],
    "write",
  );
  const recovered = (results[0]?.rowsAffected ?? 0) + (results[1]?.rowsAffected ?? 0) > 0;
  const contender = queuePosition(results[6]?.rows[0]);
  if (contender === undefined) {
    throw new Error("database admission contender was not persisted");
  }
  return enforcedResult(request, profile, {
    aheadCount: contender.ahead_count,
    contender,
    nowMs: guardrails.nowMs,
    outcome: contender.state === "active" ? "acquired" : "queued",
    recovered,
    yieldReason: contender.state === "active" ? null : (guardrails.reason ?? "queue"),
  });
}

async function renewLease(
  store: LeaseStore,
  sources: GuardrailSources,
  request: DatabaseAdmissionRequest,
  profile: AdmissionResourceProfile,
  existing: ContenderRow,
  nowMs: number,
  dependencies: AdmissionDependencies,
): Promise<DatabaseAdmissionResult> {
  const reason = isHealthSnapshotWriter(profile)
    ? null
    : await observeStoredGuardrails(sources, nowMs, dependencies);
  if (reason !== null) {
    return enforcedResult(request, profile, {
      contender: existing,
      nowMs,
      outcome: "lost",
      yieldReason: reason,
    });
  }

  const writeNowMs = injectedNowMs(dependencies);
  const renewed = await store.client.execute({
    args: [
      writeNowMs,
      renewedLeaseMs(request),
      writeNowMs,
      writeNowMs,
      existing.contender_id,
      request.fencingToken ?? 0,
      writeNowMs,
    ],
    sql: `update database_admission_contenders
          set lease_expires_at_ms = ${CLOCK_OR_INJECTED_SQL} + ?,
              queue_heartbeat_at_ms = ${CLOCK_OR_INJECTED_SQL},
              updated_at_ms = ${CLOCK_OR_INJECTED_SQL}
          where contender_id = ? and fencing_token = ? and state = 'active'
            and lease_expires_at_ms > ${CLOCK_OR_INJECTED_SQL}
          returning lease_expires_at_ms, updated_at_ms`,
  });
  const renewedRow = renewed.rows[0];
  const renewedExpiresAtMs = rowNumber(renewedRow?.lease_expires_at_ms);
  if (renewedExpiresAtMs === null) {
    return enforcedResult(request, profile, { contender: existing, nowMs, outcome: "lost" });
  }
  return enforcedResult(request, profile, {
    contender: { ...existing, lease_expires_at_ms: renewedExpiresAtMs },
    nowMs: rowNumber(renewedRow?.updated_at_ms) ?? nowMs,
    outcome: "acquired",
  });
}

async function settleEnforcedDatabaseAdmissionFor(
  store: LeaseStore,
  sources: GuardrailSources,
  request: DatabaseAdmissionRequest,
  profile: AdmissionResourceProfile,
  nowMs: number,
  dependencies: AdmissionDependencies,
  known?: Readonly<{ contender: ContenderRow | undefined }>,
): Promise<DatabaseAdmissionResult> {
  const { client } = store;
  const existing =
    known === undefined
      ? await readContender(client, request.owner, request.runId)
      : known.contender;
  let result: DatabaseAdmissionResult;
  if (request.action === "cancel") {
    const cancelled = await client.execute({
      args: [request.owner, request.runId, nowMs],
      sql: `delete from database_admission_contenders
            where owner_id = ? and run_id = ?
              and (state = 'queued' or lease_expires_at_ms <= ?)`,
    });
    result = enforcedResult(request, profile, {
      contender: existing,
      nowMs,
      outcome: "cancelled",
      recovered: existing?.state === "active" && cancelled.rowsAffected > 0,
    });
  } else if (existing?.state !== "active" || existing.fencing_token !== request.fencingToken) {
    result = enforcedResult(request, profile, { contender: existing, nowMs, outcome: "lost" });
  } else if (existing.lease_expires_at_ms === null || existing.lease_expires_at_ms <= nowMs) {
    await client.execute({
      args: [existing.contender_id, request.fencingToken ?? 0, nowMs],
      sql: `delete from database_admission_contenders
            where contender_id = ? and fencing_token = ? and state = 'active'
              and lease_expires_at_ms <= ?`,
    });
    result = enforcedResult(request, profile, { contender: existing, nowMs, outcome: "lost" });
  } else if (request.action === "heartbeat") {
    result = await renewLease(store, sources, request, profile, existing, nowMs, dependencies);
  } else {
    const settled = await client.execute({
      args: [existing.contender_id, request.fencingToken ?? 0, nowMs],
      sql: `delete from database_admission_contenders
            where contender_id = ? and fencing_token = ? and state = 'active'
              and lease_expires_at_ms > ?`,
    });
    result = enforcedResult(request, profile, {
      contender: existing,
      nowMs,
      outcome: settled.rowsAffected === 1 ? "released" : "lost",
    });
  }
  emitAdmissionTelemetry(request, result, store.kind);
  return result;
}

function shadowResult(
  request: DatabaseAdmissionRequest,
  profile: AdmissionResourceProfile,
  outcome: "shadow-acquire" | "shadow-yield",
  queueAgeMs: number,
  yieldReason: DatabaseAdmissionYieldReason | null,
): DatabaseAdmissionResult {
  return {
    contenderId: `${request.owner}:${request.runId}`,
    enforced: false,
    fencingToken: null,
    heartbeatAfterMs: DATABASE_ADMISSION_HEARTBEAT_MS,
    heavyRead: profile.heavyRead,
    holdMs: 0,
    lane: profile.lane,
    leaseExpiresAtMs: null,
    leaseRemainingMs: null,
    operationId: profile.operationId,
    outcome,
    queueAgeMs,
    recovered: false,
    retryAfterMs: null,
    waitMs: 0,
    yieldReason,
  };
}

export async function observeDatabaseAdmissionFor(
  client: AdmissionClient,
  request: DatabaseAdmissionRequest,
  dependencies: AdmissionDependencies = {},
): Promise<DatabaseAdmissionResult> {
  const profile = resourceProfileForOwner(request.owner);
  if (request.action !== "acquire") {
    const result = shadowResult(request, profile, "shadow-acquire", 0, null);
    emitAdmissionTelemetry(request, result);
    return result;
  }

  const guardrails = await observeAcquisitionGuardrails(
    { lease: client, primary: client },
    profile,
    dependencies,
  );
  const conflict = conflictingResourcePredicate(profile);
  const queuedResource = queuedResourcePredicate(profile, guardrails.storedHealthBlocked);
  const queue = await client.execute({
    args: [...conflict.args, ...queuedResource.args, ...queuedResource.args],
    sql: `select
            sum(case when state = 'active' and (${conflict.sql}) then 1 else 0 end) as active_count,
            sum(case when state = 'queued' and (${queuedResource.sql}) then 1 else 0 end)
              as queued_count,
            min(case when state = 'queued' and (${queuedResource.sql}) then enqueued_at_ms end)
              as oldest_enqueued_at_ms
          from database_admission_contenders`,
  });
  const first = queue.rows[0];
  const queueRow: QueueRow = {
    active_count: rowNumber(first?.active_count) ?? 0,
    oldest_enqueued_at_ms: rowNumber(first?.oldest_enqueued_at_ms),
    queued_count: rowNumber(first?.queued_count) ?? 0,
  };
  const queueAgeMs =
    queueRow.oldest_enqueued_at_ms === null
      ? 0
      : boundedDuration(guardrails.nowMs - queueRow.oldest_enqueued_at_ms);
  const queueBusy = queueRow.active_count > 0 || queueRow.queued_count > 0;
  const yieldReason = guardrails.reason ?? (queueBusy ? "queue" : null);
  const result = shadowResult(
    request,
    profile,
    yieldReason === null ? "shadow-acquire" : "shadow-yield",
    queueAgeMs,
    yieldReason,
  );
  emitAdmissionTelemetry(request, result);
  return result;
}

const LEGACY_STORE_ROUTE: DatabaseAdmissionStoreRoute = { epoch: null, store: "primary" };
const ZERO_TOKEN_FLOORS: Readonly<Record<DatabaseAdmissionLane, number>> = {
  "heavy-read": 0,
  write: 0,
};
const STORE_EPOCH_PATTERN = /^(primary|telemetry):([1-9][0-9]{0,8})$/;

export function parseDatabaseAdmissionStoreRoute(
  value: unknown,
): DatabaseAdmissionStoreRoute | null {
  if (value === undefined || value === null || value === "primary") {
    return LEGACY_STORE_ROUTE;
  }
  if (typeof value !== "string") {
    return null;
  }
  const match = STORE_EPOCH_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  return {
    epoch: Number(match[2]),
    store: match[1] === "telemetry" ? "telemetry" : "primary",
  };
}

type AdmissionSettings =
  | Readonly<{
      enforced: boolean;
      kind: "read";
      route: DatabaseAdmissionStoreRoute;
      telemetryEverUsed: boolean;
    }>
  | Readonly<{ kind: "unavailable" }>;

export function parseStoreEpochMarker(value: unknown): number {
  if (typeof value !== "string" || !/^[0-9]{1,9}$/.test(value)) {
    return 0;
  }
  return Number(value);
}

async function readAdmissionSettings(
  primary: AdmissionClient,
  dependencies: AdmissionDependencies,
): Promise<AdmissionSettings> {
  let read: Deadline<Awaited<ReturnType<AdmissionClient["execute"]>>>;
  try {
    read = await withinDeadline(
      primary.execute({
        args: [
          DATABASE_ADMISSION_ENFORCED_KEY,
          DATABASE_ADMISSION_STORE_KEY,
          DATABASE_ADMISSION_STORE_EPOCH_KEY,
        ],
        sql: `select key, value from settings where key in (?, ?, ?)`,
      }),
      primaryReadTimeoutMs(dependencies),
    );
  } catch {
    return { kind: "unavailable" };
  }
  if (!read.settled) {
    return { kind: "unavailable" };
  }
  const values = new Map(
    read.value.rows.flatMap((row): [string, unknown][] =>
      typeof row.key === "string" ? [[row.key, row.value]] : [],
    ),
  );
  const route = parseDatabaseAdmissionStoreRoute(values.get(DATABASE_ADMISSION_STORE_KEY));
  if (route === null) {
    throw new Error("database admission store setting is not a recognized route");
  }
  return {
    enforced: values.get(DATABASE_ADMISSION_ENFORCED_KEY) === "true",
    kind: "read",
    route,
    telemetryEverUsed: route.epoch !== null || values.has(DATABASE_ADMISSION_STORE_EPOCH_KEY),
  };
}

export async function isDatabaseAdmissionEnforcedFor(client: AdmissionClient): Promise<boolean> {
  try {
    const setting = await client.execute({
      args: [DATABASE_ADMISSION_ENFORCED_KEY],
      sql: `select value from settings where key = ? limit 1`,
    });
    return setting.rows[0]?.value === "true";
  } catch {
    return false;
  }
}

function primaryLeaseStore(
  primary: AdmissionClient,
  tokenFloors: Readonly<Record<DatabaseAdmissionLane, number>> = ZERO_TOKEN_FLOORS,
): LeaseStore {
  return {
    client: primary,
    gate: {
      args: [DATABASE_ADMISSION_STORE_KEY],
      sql: `(select coalesce(max(case when value = 'primary' or value glob 'primary:[1-9]*'
              then 1 else 0 end), 1) from settings where key = ?) = 1`,
    },
    kind: "primary",
    tokenFloors,
  };
}

function telemetryLeaseStore(telemetry: AdmissionClient, epoch: number): LeaseStore {
  return {
    client: telemetry,
    gate: {
      args: [epoch],
      sql: `exists (select 1 from database_admission_control
              where id = 1 and store_open = 1 and epoch = ?)`,
    },
    kind: "telemetry",
    tokenFloors: ZERO_TOKEN_FLOORS,
  };
}

function tokenFloorsFrom(
  rows: readonly Record<string, unknown>[],
): Record<DatabaseAdmissionLane, number> {
  const floors: Record<DatabaseAdmissionLane, number> = { ...ZERO_TOKEN_FLOORS };
  for (const row of rows) {
    const token = rowNumber(row.next_fencing_token) ?? 0;
    if (row.lane === "write" || row.lane === "heavy-read") {
      floors[row.lane] = Math.max(floors[row.lane], token);
    }
  }
  return floors;
}

const CLOCK_OR_INJECTED_SQL = `coalesce(?, cast(unixepoch('subsec') * 1000 as integer))`;

type StoreControl = Readonly<{ epoch: number; open: boolean }>;

function storeControl(row: Record<string, unknown> | undefined): StoreControl | undefined {
  const epoch = rowNumber(row?.control_epoch);
  const open = rowNumber(row?.control_open);
  return epoch === null || open === null ? undefined : { epoch, open: open === 1 };
}

type StoreHandoff =
  | Readonly<{ floors: Record<DatabaseAdmissionLane, number>; kind: "ready" }>
  | Readonly<{ kind: "draining" | "unavailable" }>;

async function readPrimaryHandoff(
  primary: AdmissionClient,
  epoch: number,
  dependencies: AdmissionDependencies,
): Promise<StoreHandoff> {
  const read = await withinDeadline(
    primary.batch(
      [
        {
          args: [
            DATABASE_ADMISSION_STORE_KEY,
            DATABASE_ADMISSION_STORE_EPOCH_KEY,
            injectedNowMs(dependencies),
          ],
          sql: `select
                  (select value from settings where key = ?) as store_route,
                  (select value from settings where key = ?) as store_epoch,
                  (select count(*) from database_admission_contenders
                    where state = 'active'
                      and lease_expires_at_ms > ${CLOCK_OR_INJECTED_SQL}) as live_count`,
        },
        { args: [], sql: `select lane, next_fencing_token from database_admission_lanes` },
      ],
      "read",
    ),
    primaryReadTimeoutMs(dependencies),
  );
  if (!read.settled) {
    return { kind: "unavailable" };
  }
  const [state, lanes] = read.value;
  const route = parseDatabaseAdmissionStoreRoute(state?.rows[0]?.store_route);
  const live = rowNumber(state?.rows[0]?.live_count) ?? 0;
  const recordedEpoch = parseStoreEpochMarker(state?.rows[0]?.store_epoch);
  if (route?.store !== "telemetry" || route.epoch !== epoch || recordedEpoch < epoch || live > 0) {
    return { kind: "draining" };
  }
  return { floors: tokenFloorsFrom(lanes?.rows ?? []), kind: "ready" };
}

async function openTelemetryStore(
  telemetry: AdmissionClient,
  epoch: number,
  floors: Readonly<Record<DatabaseAdmissionLane, number>>,
  nowMs: number,
): Promise<void> {
  await telemetry.batch(
    [
      {
        args: [epoch, nowMs],
        sql: `insert into database_admission_control (id, epoch, store_open, updated_at_ms)
              values (1, ?, 1, ?)
              on conflict(id) do update set
                epoch = excluded.epoch, store_open = 1, updated_at_ms = excluded.updated_at_ms
              where database_admission_control.epoch < excluded.epoch`,
      },
      ...(["write", "heavy-read"] as const).map((lane) => ({
        args: [lane, floors[lane], nowMs],
        sql: `insert into database_admission_lanes (lane, next_fencing_token, updated_at_ms)
              values (?, ?, ?)
              on conflict(lane) do update set
                next_fencing_token = excluded.next_fencing_token,
                updated_at_ms = excluded.updated_at_ms
              where excluded.next_fencing_token > database_admission_lanes.next_fencing_token`,
      })),
    ],
    "write",
  );
}

async function releaseTelemetryStore(
  telemetry: AdmissionClient,
  epoch: number,
  nowMs: number,
): Promise<StoreHandoff> {
  const results = await telemetry.batch(
    [
      {
        args: [epoch, nowMs],
        sql: `insert into database_admission_control (id, epoch, store_open, updated_at_ms)
              values (1, ?, 0, ?)
              on conflict(id) do update set
                epoch = excluded.epoch, store_open = 0, updated_at_ms = excluded.updated_at_ms
              where database_admission_control.epoch < excluded.epoch
                or (database_admission_control.epoch = excluded.epoch
                  and database_admission_control.store_open = 1)`,
      },
      {
        args: [nowMs],
        sql: `select
                (select epoch from database_admission_control where id = 1) as control_epoch,
                (select store_open from database_admission_control where id = 1) as control_open,
                (select count(*) from database_admission_contenders
                  where state = 'active' and lease_expires_at_ms > ?) as live_count`,
      },
      { args: [], sql: `select lane, next_fencing_token from database_admission_lanes` },
    ],
    "write",
  );
  const control = storeControl(results[1]?.rows[0]);
  const live = rowNumber(results[1]?.rows[0]?.live_count) ?? 0;
  if (control === undefined || control.epoch !== epoch || control.open || live > 0) {
    return { kind: "draining" };
  }
  return { floors: tokenFloorsFrom(results[2]?.rows ?? []), kind: "ready" };
}

async function readRetiredTelemetryStore(
  telemetry: AdmissionClient,
  dependencies: AdmissionDependencies,
): Promise<boolean | undefined> {
  try {
    const result = await telemetry.execute({
      args: [injectedNowMs(dependencies)],
      sql: `select
              (select store_open from database_admission_control where id = 1) as control_open,
              (select count(*) from database_admission_contenders
                where state = 'active'
                  and lease_expires_at_ms > ${CLOCK_OR_INJECTED_SQL}) as live_count`,
    });
    const row = result.rows[0];
    return rowNumber(row?.control_open) !== 1 && (rowNumber(row?.live_count) ?? 0) === 0;
  } catch {
    return undefined;
  }
}

async function readTelemetryControl(telemetry: AdmissionClient): Promise<StoreControl | undefined> {
  const result = await telemetry.execute(
    `select epoch as control_epoch, store_open as control_open
     from database_admission_control where id = 1`,
  );
  return storeControl(result.rows[0]);
}

function handoffResult(
  request: DatabaseAdmissionRequest,
  profile: AdmissionResourceProfile,
  nowMs: number,
  yieldReason: DatabaseAdmissionYieldReason,
  store: DatabaseAdmissionStoreKind,
): DatabaseAdmissionResult {
  const result = {
    ...enforcedResult(request, profile, { nowMs, outcome: "queued", yieldReason }),
    retryAfterMs: DATABASE_ADMISSION_MAX_RETRY_AFTER_MS,
  };
  emitAdmissionTelemetry(request, result, store);
  return result;
}

async function acquireWithBusyRetry(
  store: LeaseStore,
  sources: GuardrailSources,
  request: DatabaseAdmissionRequest,
  profile: AdmissionResourceProfile,
  dependencies: AdmissionDependencies,
): Promise<DatabaseAdmissionResult> {
  const guardrails = await observeAcquisitionGuardrails(sources, profile, dependencies);
  const wait = dependencies.wait ?? waitFor;
  let attempt = 0;
  let result: DatabaseAdmissionResult;
  while (true) {
    try {
      result = await acquireEnforcedDatabaseAdmissionFor(store, request, profile, guardrails);
      break;
    } catch (error) {
      if (!isDatabaseBusy(error) || attempt >= DATABASE_ADMISSION_TRANSACTION_RETRIES) {
        throw error;
      }
      attempt += 1;
      await wait(Math.min(5 * attempt, 25));
    }
  }
  emitAdmissionTelemetry(request, result, store.kind);
  return result;
}

async function acquireInPrimaryStore(
  stores: DatabaseAdmissionStores,
  route: DatabaseAdmissionStoreRoute,
  telemetryEverUsed: boolean,
  request: DatabaseAdmissionRequest,
  profile: AdmissionResourceProfile,
  dependencies: AdmissionDependencies,
): Promise<DatabaseAdmissionResult> {
  let floors = ZERO_TOKEN_FLOORS;
  if (route.epoch === null && (telemetryEverUsed || stores.telemetry !== undefined)) {
    const retired =
      stores.telemetry === undefined
        ? undefined
        : await readRetiredTelemetryStore(stores.telemetry, dependencies);
    if (retired === false || (retired === undefined && telemetryEverUsed)) {
      return handoffResult(
        request,
        profile,
        await readStoreClock(stores.primary, dependencies),
        "queue",
        "primary",
      );
    }
  }
  if (route.epoch !== null) {
    if (stores.telemetry === undefined) {
      throw new Error(
        "database admission is rolling back to the primary store, which needs the telemetry store to confirm the handoff",
      );
    }
    const nowMs = await readStoreClock(stores.telemetry, dependencies);
    const handoff = await releaseTelemetryStore(stores.telemetry, route.epoch, nowMs);
    if (handoff.kind !== "ready") {
      return handoffResult(request, profile, nowMs, "queue", "primary");
    }
    floors = handoff.floors;
  }
  return acquireWithBusyRetry(
    primaryLeaseStore(stores.primary, floors),
    { lease: stores.primary, primary: stores.primary, probes: stores.telemetry },
    request,
    profile,
    dependencies,
  );
}

async function acquireInTelemetryStore(
  stores: DatabaseAdmissionStores,
  epoch: number,
  request: DatabaseAdmissionRequest,
  profile: AdmissionResourceProfile,
  dependencies: AdmissionDependencies,
): Promise<DatabaseAdmissionResult> {
  const telemetry = stores.telemetry;
  if (telemetry === undefined) {
    throw new Error("database admission is routed to the telemetry store, which is not configured");
  }
  const control = await readTelemetryControl(telemetry);
  if (control === undefined || control.epoch !== epoch || !control.open) {
    const nowMs = await readStoreClock(telemetry, dependencies);
    if (control !== undefined && control.epoch >= epoch) {
      return handoffResult(request, profile, nowMs, "queue", "telemetry");
    }
    const handoff = await readPrimaryHandoff(stores.primary, epoch, dependencies);
    if (handoff.kind !== "ready") {
      return handoffResult(
        request,
        profile,
        nowMs,
        handoff.kind === "unavailable" ? "direct-read-latency" : "queue",
        "telemetry",
      );
    }
    await openTelemetryStore(telemetry, epoch, handoff.floors, nowMs);
  }
  return acquireWithBusyRetry(
    telemetryLeaseStore(telemetry, epoch),
    { lease: telemetry, primary: stores.primary, probes: telemetry },
    request,
    profile,
    dependencies,
  );
}

type TelemetryLookup = Readonly<{
  contender: ContenderRow | undefined;
  control: StoreControl | undefined;
}>;

async function lookupTelemetryContender(
  telemetry: AdmissionClient,
  request: DatabaseAdmissionRequest,
): Promise<TelemetryLookup | undefined> {
  try {
    const result = await telemetry.execute({
      args: [request.owner, request.runId],
      sql: `select c.contender_id, c.state, c.enqueued_at_ms, c.acquired_at_ms, c.fencing_token,
                   c.operation_id, c.lease_expires_at_ms, c.queue_heartbeat_at_ms,
                   control.epoch as control_epoch, control.store_open as control_open
            from (select 1) as anchor
            left join database_admission_contenders as c
              on c.owner_id = ? and c.run_id = ?
            left join database_admission_control as control on control.id = 1
            limit 1`,
    });
    const row = result.rows[0];
    return { contender: contenderRow(row), control: storeControl(row) };
  } catch {
    return undefined;
  }
}

function settlesInTelemetry(request: DatabaseAdmissionRequest, lookup: TelemetryLookup): boolean {
  const contender = lookup.contender;
  if (contender !== undefined && request.action === "cancel") {
    return true;
  }
  if (contender?.state === "active" && contender.fencing_token === request.fencingToken) {
    return true;
  }
  return lookup.control?.open === true;
}

export async function coordinateDatabaseAdmissionAcross(
  stores: DatabaseAdmissionStores,
  request: DatabaseAdmissionRequest,
  dependencies: AdmissionDependencies & { enforced?: boolean } = {},
): Promise<DatabaseAdmissionResult> {
  const profile = resourceProfileForOwner(request.owner);
  if (request.action !== "acquire" && stores.telemetry !== undefined) {
    const lookup = await lookupTelemetryContender(stores.telemetry, request);
    if (lookup !== undefined && settlesInTelemetry(request, lookup)) {
      const nowMs = await readStoreClock(stores.telemetry, dependencies);
      return settleEnforcedDatabaseAdmissionFor(
        telemetryLeaseStore(stores.telemetry, lookup.control?.epoch ?? 0),
        { lease: stores.telemetry, primary: stores.primary, probes: stores.telemetry },
        request,
        profile,
        nowMs,
        dependencies,
        { contender: lookup.contender },
      );
    }
  }

  const settings: AdmissionSettings =
    dependencies.enforced === undefined
      ? await readAdmissionSettings(stores.primary, dependencies)
      : {
          enforced: dependencies.enforced,
          kind: "read",
          route: LEGACY_STORE_ROUTE,
          telemetryEverUsed: false,
        };
  if (settings.kind === "unavailable") {
    const result = enforcedResult(request, profile, {
      nowMs: 0,
      outcome: request.action === "acquire" ? "queued" : "lost",
      yieldReason: "direct-read-latency",
    });
    emitAdmissionTelemetry(request, result);
    return result;
  }
  if (!settings.enforced) {
    return observeDatabaseAdmissionFor(stores.primary, request, dependencies);
  }

  if (request.action !== "acquire") {
    const nowMs = await readStoreClock(stores.primary, dependencies);
    return settleEnforcedDatabaseAdmissionFor(
      primaryLeaseStore(stores.primary),
      { lease: stores.primary, primary: stores.primary, probes: stores.telemetry },
      request,
      profile,
      nowMs,
      dependencies,
    );
  }

  if (settings.route.store === "telemetry" && settings.route.epoch !== null) {
    return acquireInTelemetryStore(stores, settings.route.epoch, request, profile, dependencies);
  }
  return acquireInPrimaryStore(
    stores,
    settings.route,
    settings.telemetryEverUsed,
    request,
    profile,
    dependencies,
  );
}

export async function coordinateDatabaseAdmissionFor(
  client: AdmissionClient,
  request: DatabaseAdmissionRequest,
  dependencies: AdmissionDependencies & { enforced?: boolean } = {},
): Promise<DatabaseAdmissionResult> {
  return coordinateDatabaseAdmissionAcross({ primary: client }, request, dependencies);
}

export async function recordDatabaseWriteProbeFor(
  stores: DatabaseAdmissionStores,
  dependencies: Pick<AdmissionDependencies, "monotonicNow" | "serverNowMs"> & {
    timeoutMs?: number;
  } = {},
): Promise<DatabaseWriteProbeResult> {
  const monotonicNow = dependencies.monotonicNow ?? performance.now.bind(performance);
  const startedAt = monotonicNow();
  let outcome: DatabaseWriteProbeOutcome;
  let latencyMs: number | null;
  try {
    const write = await withinDeadline(
      stores.primary.execute({
        args: [DATABASE_WRITE_PROBE_KEY, new Date().toISOString()],
        sql: `insert into settings (key, value) values (?, ?)
              on conflict(key) do update set value = excluded.value`,
      }),
      dependencies.timeoutMs ?? DATABASE_WRITE_PROBE_TIMEOUT_MS,
    );
    const elapsedMs = boundedDuration(monotonicNow() - startedAt);
    latencyMs = write.settled ? elapsedMs : null;
    outcome = !write.settled ? "stalled" : elapsedMs > DATABASE_WRITE_PROBE_SLOW_MS ? "slow" : "ok";
  } catch {
    latencyMs = null;
    outcome = "failed";
  }

  let recorded = false;
  if (stores.telemetry !== undefined) {
    try {
      const observedAt = dependencies.serverNowMs ?? null;
      await stores.telemetry.batch(
        [
          {
            args: [crypto.randomUUID(), observedAt, latencyMs, outcome],
            sql: `insert into database_write_probes (id, observed_at_ms, latency_ms, outcome)
                  values (?, ${CLOCK_OR_INJECTED_SQL}, ?, ?)`,
          },
          {
            args: [observedAt, DATABASE_WRITE_PROBE_RETENTION_MS, DATABASE_WRITE_PROBE_PRUNE_LIMIT],
            sql: `delete from database_write_probes where id in (
                    select id from database_write_probes
                    where observed_at_ms < ${CLOCK_OR_INJECTED_SQL} - ?
                    order by observed_at_ms asc, id asc limit ?
                  )`,
          },
        ],
        "write",
      );
      recorded = true;
    } catch {
      recorded = false;
    }
  }

  logEvent("info", "database.write_probe", {
    latency_ms: latencyMs,
    outcome,
    recorded,
  });
  return { latencyMs, outcome, recorded };
}
