import { type Client } from "@libsql/client";
import { logEvent } from "./log";
import { DATABASE_OPERATION_ID_MAX_LENGTH } from "./database-observability";
import { resolveDatabaseOperationOwner } from "./database-operation-registry";

export const DATABASE_ADMISSION_LEASE_MS = 90_000;
export const DATABASE_ADMISSION_HEARTBEAT_MS = 30_000;
export const DATABASE_ADMISSION_QUEUE_TTL_MS = 120_000;
export const DATABASE_ADMISSION_HEALTH_STALE_MS = 20 * 60 * 1000;
export const DATABASE_ADMISSION_DIRECT_READ_LIMIT_MS = 250;
export const DATABASE_ADMISSION_PUBLIC_LATENCY_LIMIT_MS = 500;
export const DATABASE_ADMISSION_ENFORCED_KEY = "database_admission_enforced";
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
  | "queue";

export type DatabaseAdmissionRequest = Readonly<{
  action: DatabaseAdmissionAction;
  fencingToken?: number;
  owner: string;
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
  operationId: string;
  outcome: DatabaseAdmissionOutcome;
  queueAgeMs: number;
  recovered: boolean;
  waitMs: number;
  yieldReason: DatabaseAdmissionYieldReason | null;
}>;

type AdmissionClient = Pick<Client, "batch" | "execute">;

type AdmissionDependencies = Readonly<{
  monotonicNow?: () => number;
  serverNowMs?: number;
  wait?: (delayMs: number) => Promise<void>;
}>;

type HealthRow = Readonly<{
  checked_at: string;
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
  state: "active" | "queued";
}>;

type GuardrailObservation = Readonly<{
  directReadLatencyMs: number;
  nowMs: number;
  reason: DatabaseAdmissionYieldReason | null;
}>;

type AdmissionResourceProfile = Readonly<{
  heavyRead: boolean;
  lane: DatabaseAdmissionLane;
  operationId: string;
}>;

type SqlPredicate = Readonly<{
  args: readonly string[];
  sql: string;
}>;

const HEAVY_READER_OPERATION_SUFFIX = "|heavy-read";

function boundedDuration(value: number): number {
  return Math.max(0, Math.round(value));
}

function isDatabaseBusy(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === "SQLITE_BUSY"
  );
}

function waitFor(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
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

/**
 * A mixed writer/heavy-reader owns the physical write lane but conflicts with both resources.
 * Heavy readers reciprocally conflict with the resource suffix persisted when a contender joins,
 * so a rolling registry change cannot weaken an already-held lease. The predicate is reused for
 * active exclusion and FIFO ordering inside one serialized batch.
 */
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

function rowNumber(value: unknown): number | null {
  return typeof value === "number" || typeof value === "bigint" ? Number(value) : null;
}

function healthReason(
  rows: readonly HealthRow[],
  nowMs: number,
): DatabaseAdmissionYieldReason | null {
  const database = rows.find((row) => row.service === "db");
  if (database !== undefined) {
    const checkedAt = Date.parse(database.checked_at);
    if (
      database.status !== "ok" ||
      !Number.isFinite(checkedAt) ||
      nowMs - checkedAt > DATABASE_ADMISSION_HEALTH_STALE_MS
    ) {
      return "database-health";
    }
  }

  const web = rows.find((row) => row.service === "web");
  if (web !== undefined) {
    const checkedAt = Date.parse(web.checked_at);
    if (
      web.status !== "ok" ||
      !Number.isFinite(checkedAt) ||
      nowMs - checkedAt > DATABASE_ADMISSION_HEALTH_STALE_MS ||
      (web.latency_ms !== null && web.latency_ms > DATABASE_ADMISSION_PUBLIC_LATENCY_LIMIT_MS)
    ) {
      return "public-latency";
    }
  }

  return null;
}

async function observeGuardrails(
  client: AdmissionClient,
  dependencies: AdmissionDependencies,
  includeStoredHealth = true,
): Promise<GuardrailObservation> {
  const monotonicNow = dependencies.monotonicNow ?? performance.now.bind(performance);
  const startedAt = monotonicNow();
  const clock = await client.execute(
    `select cast(unixepoch('subsec') * 1000 as integer) as now_ms`,
  );
  const directReadLatencyMs = boundedDuration(monotonicNow() - startedAt);
  const databaseNowMs = rowNumber(clock.rows[0]?.now_ms);
  const nowMs = dependencies.serverNowMs ?? databaseNowMs;
  if (nowMs === null) {
    throw new Error("database admission could not read the database clock");
  }

  if (directReadLatencyMs > DATABASE_ADMISSION_DIRECT_READ_LIMIT_MS) {
    return { directReadLatencyMs, nowMs, reason: "direct-read-latency" };
  }

  // The snapshot writer is the mechanism that clears a stored degraded/down row after a live
  // probe recovers. Its current harmless DB read remains load-bearing, but gating it on its own
  // previous snapshot would make recovery impossible.
  if (!includeStoredHealth) {
    return { directReadLatencyMs, nowMs, reason: null };
  }

  const health = await client.execute(
    `select service, status, latency_ms, checked_at
       from service_status
       where service in ('db', 'web')`,
  );
  const rows = health.rows.flatMap((row): HealthRow[] => {
    if (
      typeof row.service !== "string" ||
      typeof row.status !== "string" ||
      typeof row.checked_at !== "string"
    ) {
      return [];
    }
    return [
      {
        checked_at: row.checked_at,
        latency_ms: rowNumber(row.latency_ms),
        service: row.service,
        status: row.status,
      },
    ];
  });

  return { directReadLatencyMs, nowMs, reason: healthReason(rows, nowMs) };
}

function emitAdmissionTelemetry(
  request: DatabaseAdmissionRequest,
  result: DatabaseAdmissionResult,
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
    state: row.state,
  };
}

function enforcedResult(
  request: DatabaseAdmissionRequest,
  profile: AdmissionResourceProfile,
  options: {
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
  return {
    contenderId: `${request.owner}:${request.runId}`,
    enforced: true,
    fencingToken: options.contender?.fencing_token ?? null,
    heartbeatAfterMs: DATABASE_ADMISSION_HEARTBEAT_MS,
    heavyRead:
      profile.heavyRead ||
      options.contender?.operation_id.endsWith(HEAVY_READER_OPERATION_SUFFIX) === true,
    holdMs:
      acquiredAtMs === null || acquiredAtMs === undefined
        ? 0
        : boundedDuration(options.nowMs - acquiredAtMs),
    lane: profile.lane,
    leaseExpiresAtMs: options.contender?.lease_expires_at_ms ?? null,
    operationId: profile.operationId,
    outcome: options.outcome,
    queueAgeMs,
    recovered: options.recovered ?? false,
    waitMs: queueAgeMs,
    yieldReason: options.yieldReason ?? null,
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
                 lease_expires_at_ms
            from database_admission_contenders
            where owner_id = ? and run_id = ?
            limit 1`,
  });
  return contenderRow(result.rows[0]);
}

async function acquireEnforcedDatabaseAdmissionFor(
  client: AdmissionClient,
  request: DatabaseAdmissionRequest,
  profile: AdmissionResourceProfile,
  guardrails: GuardrailObservation,
): Promise<DatabaseAdmissionResult> {
  const contenderId = `${request.owner}:${request.runId}`;
  const staleQueueBeforeMs = guardrails.nowMs - DATABASE_ADMISSION_QUEUE_TTL_MS;
  const mayAcquire = guardrails.reason === null ? 1 : 0;
  const leaseExpiresAtMs = guardrails.nowMs + DATABASE_ADMISSION_LEASE_MS;
  const conflict = conflictingResourcePredicate(profile);
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
        args: [profile.lane, guardrails.nowMs],
        sql: `insert into database_admission_lanes (lane, next_fencing_token, updated_at_ms)
              values (?, 0, ?)
              on conflict(lane) do nothing`,
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
          ...conflict.args,
          contenderId,
          ...conflict.args,
        ],
        sql: `update database_admission_lanes
              set next_fencing_token = next_fencing_token + 1, updated_at_ms = ?
              where lane = ? and ? = 1
                and not exists (
                  select 1 from database_admission_contenders
                  where ${conflict.sql} and state = 'active'
                )
                and ? = (
                  select contender_id from database_admission_contenders
                  where ${conflict.sql} and state = 'queued'
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
          ...conflict.args,
          ...conflict.args,
        ],
        sql: `update database_admission_contenders
              set state = 'active', acquired_at_ms = ?,
                  fencing_token = (select next_fencing_token from database_admission_lanes where lane = ?),
                  lease_expires_at_ms = ?, updated_at_ms = ?
              where contender_id = ? and state = 'queued' and ? = 1
                and not exists (
                  select 1 from database_admission_contenders
                  where ${conflict.sql} and state = 'active'
                )
                and contender_id = (
                  select contender_id from database_admission_contenders
                  where ${conflict.sql} and state = 'queued'
                  order by enqueued_at_ms asc, contender_id asc limit 1
                )`,
      },
      {
        args: [request.owner, request.runId],
        sql: `select contender_id, state, enqueued_at_ms, acquired_at_ms, fencing_token, operation_id,
                     lease_expires_at_ms
                from database_admission_contenders
                where owner_id = ? and run_id = ? limit 1`,
      },
    ],
    "write",
  );
  const recovered = (results[0]?.rowsAffected ?? 0) + (results[1]?.rowsAffected ?? 0) > 0;
  const contender = contenderRow(results[6]?.rows[0]);
  if (contender === undefined) {
    throw new Error("database admission contender was not persisted");
  }
  return enforcedResult(request, profile, {
    contender,
    nowMs: guardrails.nowMs,
    outcome: contender.state === "active" ? "acquired" : "queued",
    recovered,
    yieldReason: contender.state === "active" ? null : (guardrails.reason ?? "queue"),
  });
}

async function settleEnforcedDatabaseAdmissionFor(
  client: AdmissionClient,
  request: DatabaseAdmissionRequest,
  profile: AdmissionResourceProfile,
  guardrails: GuardrailObservation,
): Promise<DatabaseAdmissionResult> {
  const existing = await readContender(client, request.owner, request.runId);
  if (request.action === "cancel") {
    await client.execute({
      args: [request.owner, request.runId],
      sql: `delete from database_admission_contenders
            where owner_id = ? and run_id = ? and state = 'queued'`,
    });
    const result = enforcedResult(request, profile, {
      contender: existing,
      nowMs: guardrails.nowMs,
      outcome: "cancelled",
    });
    emitAdmissionTelemetry(request, result);
    return result;
  }

  if (existing?.state !== "active" || existing.fencing_token !== request.fencingToken) {
    const result = enforcedResult(request, profile, {
      contender: existing,
      nowMs: guardrails.nowMs,
      outcome: "lost",
    });
    emitAdmissionTelemetry(request, result);
    return result;
  }

  if (existing.lease_expires_at_ms === null || existing.lease_expires_at_ms <= guardrails.nowMs) {
    await client.execute({
      args: [existing.contender_id, request.fencingToken, guardrails.nowMs],
      sql: `delete from database_admission_contenders
            where contender_id = ? and fencing_token = ? and state = 'active'
              and lease_expires_at_ms <= ?`,
    });
    const result = enforcedResult(request, profile, {
      contender: existing,
      nowMs: guardrails.nowMs,
      outcome: "lost",
    });
    emitAdmissionTelemetry(request, result);
    return result;
  }

  if (request.action === "heartbeat" && guardrails.reason === null) {
    const leaseExpiresAtMs = guardrails.nowMs + DATABASE_ADMISSION_LEASE_MS;
    const renewed = await client.execute({
      args: [
        leaseExpiresAtMs,
        guardrails.nowMs,
        guardrails.nowMs,
        existing.contender_id,
        request.fencingToken,
        guardrails.nowMs,
      ],
      sql: `update database_admission_contenders
            set lease_expires_at_ms = ?, queue_heartbeat_at_ms = ?, updated_at_ms = ?
            where contender_id = ? and fencing_token = ? and state = 'active'
              and lease_expires_at_ms > ?`,
    });
    if (renewed.rowsAffected === 1) {
      const contender: ContenderRow = { ...existing, lease_expires_at_ms: leaseExpiresAtMs };
      const result = enforcedResult(request, profile, {
        contender,
        nowMs: guardrails.nowMs,
        outcome: "acquired",
      });
      emitAdmissionTelemetry(request, result);
      return result;
    }
  }

  const settled = await client.execute({
    args: [existing.contender_id, request.fencingToken, guardrails.nowMs],
    sql: `delete from database_admission_contenders
          where contender_id = ? and fencing_token = ? and state = 'active'
            and lease_expires_at_ms > ?`,
  });
  const yielded = request.action === "heartbeat" && guardrails.reason !== null;
  const lost = request.action === "heartbeat" || settled.rowsAffected !== 1;
  const result = enforcedResult(request, profile, {
    contender: existing,
    nowMs: guardrails.nowMs,
    outcome: lost ? "lost" : "released",
    yieldReason: yielded ? guardrails.reason : null,
  });
  emitAdmissionTelemetry(request, result);
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
    operationId: profile.operationId,
    outcome,
    queueAgeMs,
    recovered: false,
    waitMs: 0,
    yieldReason,
  };
}

/**
 * Observe the exact registry lane, durable queue, database clock, and public-priority guardrails
 * without inserting a contender or delaying/stopping the caller. This is the dark compatibility
 * path: every response is explicitly `enforced: false`.
 */
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

  const guardrails = await observeGuardrails(
    client,
    dependencies,
    profile.operationId !== "health.snapshot",
  );
  const conflict = conflictingResourcePredicate(profile);
  const queue = await client.execute({
    args: [...conflict.args],
    sql: `select
            sum(case when state = 'active' then 1 else 0 end) as active_count,
            sum(case when state = 'queued' then 1 else 0 end) as queued_count,
            min(case when state = 'queued' then enqueued_at_ms end) as oldest_enqueued_at_ms
          from database_admission_contenders
          where ${conflict.sql}`,
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

/** Only the exact settings value `true` enables enforcement; absent/malformed/read-failed is dark. */
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

/**
 * Coordinate one polling turn. The caller bounds total acquisition wait and owns the payload;
 * this function keeps every database transaction to queue maintenance plus one state transition.
 */
export async function coordinateDatabaseAdmissionFor(
  client: AdmissionClient,
  request: DatabaseAdmissionRequest,
  dependencies: AdmissionDependencies & { enforced?: boolean } = {},
): Promise<DatabaseAdmissionResult> {
  const enforced = dependencies.enforced ?? (await isDatabaseAdmissionEnforcedFor(client));
  if (!enforced) {
    return observeDatabaseAdmissionFor(client, request, dependencies);
  }

  const profile = resourceProfileForOwner(request.owner);
  const guardrails = await observeGuardrails(
    client,
    dependencies,
    profile.operationId !== "health.snapshot",
  );
  let result: DatabaseAdmissionResult;
  if (request.action === "acquire") {
    const wait = dependencies.wait ?? waitFor;
    let attempt = 0;
    while (true) {
      try {
        result = await acquireEnforcedDatabaseAdmissionFor(client, request, profile, guardrails);
        break;
      } catch (error) {
        if (!isDatabaseBusy(error) || attempt >= DATABASE_ADMISSION_TRANSACTION_RETRIES) {
          throw error;
        }
        attempt += 1;
        await wait(Math.min(5 * attempt, 25));
      }
    }
  } else {
    result = await settleEnforcedDatabaseAdmissionFor(client, request, profile, guardrails);
  }
  if (request.action === "acquire") {
    emitAdmissionTelemetry(request, result);
  }
  return result;
}
