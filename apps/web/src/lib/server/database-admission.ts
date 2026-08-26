import { type Client } from "@libsql/client";
import { logEvent } from "./log";
import { resolveDatabaseOperationOwner } from "./database-operation-registry";

export const DATABASE_ADMISSION_LEASE_MS = 90_000;
export const DATABASE_ADMISSION_HEARTBEAT_MS = 30_000;
export const DATABASE_ADMISSION_QUEUE_TTL_MS = 120_000;
export const DATABASE_ADMISSION_HEALTH_STALE_MS = 20 * 60 * 1000;
export const DATABASE_ADMISSION_DIRECT_READ_LIMIT_MS = 250;
export const DATABASE_ADMISSION_PUBLIC_LATENCY_LIMIT_MS = 500;

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

type AdmissionClient = Pick<Client, "execute">;

type AdmissionDependencies = Readonly<{
  monotonicNow?: () => number;
  serverNowMs?: number;
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

type GuardrailObservation = Readonly<{
  directReadLatencyMs: number;
  nowMs: number;
  reason: DatabaseAdmissionYieldReason | null;
}>;

function boundedDuration(value: number): number {
  return Math.max(0, Math.round(value));
}

function laneForOwner(owner: string): { lane: DatabaseAdmissionLane; operationId: string } {
  const operation = resolveDatabaseOperationOwner(owner);
  if (operation?.accessClass === "write") {
    return { lane: "write", operationId: operation.operationId };
  }
  if (operation?.accessClass === "heavy-read" && operation.heavy) {
    return { lane: "heavy-read", operationId: operation.operationId };
  }

  throw new Error(`database admission owner is not a classified writer or heavy reader: ${owner}`);
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

function shadowResult(
  request: DatabaseAdmissionRequest,
  lane: DatabaseAdmissionLane,
  operationId: string,
  outcome: "shadow-acquire" | "shadow-yield",
  queueAgeMs: number,
  yieldReason: DatabaseAdmissionYieldReason | null,
): DatabaseAdmissionResult {
  return {
    contenderId: `${request.owner}:${request.runId}`,
    enforced: false,
    fencingToken: null,
    heartbeatAfterMs: DATABASE_ADMISSION_HEARTBEAT_MS,
    holdMs: 0,
    lane,
    leaseExpiresAtMs: null,
    operationId,
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
  const { lane, operationId } = laneForOwner(request.owner);
  if (request.action !== "acquire") {
    const result = shadowResult(request, lane, operationId, "shadow-acquire", 0, null);
    emitAdmissionTelemetry(request, result);
    return result;
  }

  const guardrails = await observeGuardrails(client, dependencies);
  const queue = await client.execute({
    args: [lane],
    sql: `select
            sum(case when state = 'active' then 1 else 0 end) as active_count,
            sum(case when state = 'queued' then 1 else 0 end) as queued_count,
            min(case when state = 'queued' then enqueued_at_ms end) as oldest_enqueued_at_ms
          from database_admission_contenders
          where lane = ?`,
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
    lane,
    operationId,
    yieldReason === null ? "shadow-acquire" : "shadow-yield",
    queueAgeMs,
    yieldReason,
  );
  emitAdmissionTelemetry(request, result);
  return result;
}
