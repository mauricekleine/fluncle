import { randomUUID } from "node:crypto";
import { type Client } from "@libsql/client";
import { type ServiceHealthStatus } from "@fluncle/contracts";
import {
  HEALTH_SNAPSHOT_PRODUCER_MAX,
  HEALTH_SNAPSHOT_PRODUCER_PATTERN,
} from "@fluncle/contracts/orpc";
import { cronSurfaces } from "@fluncle/registry";
import { SELF_POSTED_AUTOMATION_ORDER } from "../status-services";
import { getDb, typedRows } from "./db";
import { logEvent } from "./log";
import {
  digestOperationRequest,
  executeReceiptBackedOperation,
  type OperationReceiptOutcome,
} from "./operation-receipts";

export type { ServiceHealthStatus };

export type ServiceStatusRow = {
  checked_at: string | null;
  latency_ms: number | null;
  message: string | null;
  service: string;
  since: string | null;
  status: ServiceHealthStatus;
};

export type StatusEventRow = {
  at: string;
  id: string;
  message: string | null;
  service: string;
  status: ServiceHealthStatus;
};

export type ServiceCheckSampleRow = {
  at: string;
  latency_ms: number | null;
  service: string;
  status: ServiceHealthStatus;
};

export type HealthCheckInput = {
  latencyMs: number | null;
  message: string | null;
  service: string;
  status: ServiceHealthStatus;
  transitioned: boolean;
};

export const HEALTH_SNAPSHOT_OPERATION_ID = "health.snapshot";

const MESSAGE_MAX = 160;
const RATE_LIMIT_COUNTER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function normalizeHealthSnapshotAt(at: string): string {
  try {
    return new Date(at).toISOString();
  } catch {
    throw new TypeError("at must be a valid ISO timestamp");
  }
}

export function normalizeHealthCheck(check: HealthCheckInput): HealthCheckInput {
  const collapsed = check.message?.replace(/\s+/g, " ").trim() ?? "";
  const message =
    collapsed.length === 0
      ? null
      : collapsed.length > MESSAGE_MAX
        ? `${collapsed.slice(0, MESSAGE_MAX - 1)}…`
        : collapsed;

  return {
    latencyMs: check.latencyMs,
    message,
    service: check.service.trim(),
    status: check.status,
    transitioned: check.transitioned,
  };
}

export function normalizeHealthSnapshot(
  at: string,
  checks: HealthCheckInput[],
): { at: string; checks: HealthCheckInput[] } {
  return {
    at: normalizeHealthSnapshotAt(at),
    checks: checks.map(normalizeHealthCheck),
  };
}

function validateHealthSnapshotProducer(producer: string): void {
  if (
    producer.length > HEALTH_SNAPSHOT_PRODUCER_MAX ||
    !HEALTH_SNAPSHOT_PRODUCER_PATTERN.test(producer)
  ) {
    throw new TypeError("producer must be a bounded stable identifier");
  }
}

export function healthSnapshotOperationKey(producer: string, at: string): string {
  validateHealthSnapshotProducer(producer);
  return `${HEALTH_SNAPSHOT_OPERATION_ID}:${producer}:${normalizeHealthSnapshotAt(at)}`;
}

export async function healthSnapshotRequestDigest(
  producer: string,
  at: string,
  checks: HealthCheckInput[],
): Promise<string> {
  validateHealthSnapshotProducer(producer);
  const snapshot = normalizeHealthSnapshot(at, checks);

  return digestOperationRequest({ ...snapshot, producer });
}

const STATUS_EVENTS_KEEP = 200;

const SERVICE_CHECK_SAMPLES_KEEP = 90;

type HealthSnapshotWriteClient = Pick<Client, "execute">;

const CRON_SURFACES = cronSurfaces();
const STATUS_STALE_CYCLES = 3;
const STATUS_STALE_FLOOR_MS = 90_000;
const SELF_POSTED_CADENCE_MS = 60 * 60_000;

function statusProberCadenceMs(): number {
  const cadenceMs = CRON_SURFACES.find((surface) => surface.name === "cron.healthcheck")
    ?.probeConfig?.cadenceMs;

  if (cadenceMs === undefined) {
    throw new Error("cron.healthcheck must declare the status prober cadence");
  }

  return cadenceMs;
}

const STATUS_PROBER_CADENCE_MS = statusProberCadenceMs();
const EXPECTED_STATUS_WRITER_CADENCE_MS = new Map<string, number>([
  ...CRON_SURFACES.map((surface) => [surface.name, STATUS_PROBER_CADENCE_MS] as const),
  ...SELF_POSTED_AUTOMATION_ORDER.map((service) => [service, SELF_POSTED_CADENCE_MS] as const),
]);

const RETIRED_SERVICE_IDS = new Set([
  "automation",
  "cron.apple-releases",
  "cron.artist-follow",
  "cron.clip-drip",
]);

const NO_RUNS_GRACE_MS = 24 * 60 * 60 * 1000;

const NO_RUNS_MESSAGE = /no runs yet/i;

function honestNoRuns(row: ServiceStatusRow, now: number): ServiceStatusRow {
  if (row.status !== "ok" || !NO_RUNS_MESSAGE.test(row.message ?? "")) {
    return row;
  }

  if (row.since === null) {
    return row;
  }

  const since = Date.parse(row.since);

  if (Number.isNaN(since) || now - since <= NO_RUNS_GRACE_MS) {
    return row;
  }

  return {
    ...row,
    message: "never run — the cron is registered but appears not to be deployed",
    status: "degraded",
  };
}

function honestFreshness(row: ServiceStatusRow, now: number): ServiceStatusRow {
  if (row.status !== "ok") {
    return row;
  }

  if (row.checked_at === null) {
    return row;
  }

  const checkedAt = Date.parse(row.checked_at);
  const cadenceMs = EXPECTED_STATUS_WRITER_CADENCE_MS.get(row.service) ?? STATUS_PROBER_CADENCE_MS;
  const staleBudgetMs = Math.max(cadenceMs * STATUS_STALE_CYCLES, STATUS_STALE_FLOOR_MS);

  if (Number.isNaN(checkedAt) || now - checkedAt <= staleBudgetMs) {
    return row;
  }

  return {
    ...row,
    message: "last report is stale",
    status: "degraded",
  };
}

function neverReportedStatuses(rows: ServiceStatusRow[]): ServiceStatusRow[] {
  const reported = new Set(rows.map((row) => row.service));

  return [...EXPECTED_STATUS_WRITER_CADENCE_MS.keys()]
    .filter((service) => !reported.has(service))
    .map((service) => ({
      checked_at: null,
      latency_ms: null,
      message: "never reported",
      service,
      since: null,
      status: "degraded",
    }));
}

export async function getServiceStatuses(now = Date.now()): Promise<ServiceStatusRow[]> {
  const db = await getDb();
  const result = await db.execute(
    `select service, status, message, latency_ms, checked_at, since
       from service_status
       order by checked_at desc`,
  );

  const storedRows = typedRows<ServiceStatusRow>(result.rows);
  const rows = storedRows
    .filter((row) => !RETIRED_SERVICE_IDS.has(row.service))
    .map((row) => honestFreshness(honestNoRuns(row, now), now));

  return storedRows.length === 0 ? [] : [...rows, ...neverReportedStatuses(rows)];
}

export async function getRecentStatusEvents(limit = 15): Promise<StatusEventRow[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [limit],
    sql: `select id, service, status, message, at
            from status_events
            order by at desc, id desc
            limit ?`,
  });

  return typedRows<StatusEventRow>(result.rows);
}

export async function getServiceCheckSamples(): Promise<Record<string, ServiceCheckSampleRow[]>> {
  const db = await getDb();
  const result = await db.execute(
    `select service, status, latency_ms, at
       from service_check_samples
       order by service asc, at asc`,
  );

  const byService: Record<string, ServiceCheckSampleRow[]> = {};

  for (const row of typedRows<ServiceCheckSampleRow>(result.rows)) {
    (byService[row.service] ??= []).push(row);
  }

  return byService;
}

async function writeHealthSnapshot(
  db: HealthSnapshotWriteClient,
  at: string,
  checks: HealthCheckInput[],
  strictSamples: boolean,
): Promise<void> {
  for (const check of checks) {
    await db.execute({
      args: [check.service, check.status, check.message, check.latencyMs, at, at],
      sql: `insert into service_status (service, status, message, latency_ms, checked_at, since)
              values (?, ?, ?, ?, ?, ?)
              on conflict(service) do update set
                latency_ms = excluded.latency_ms,
                message = excluded.message,
                since = case
                  when service_status.status = excluded.status then service_status.since
                  else excluded.checked_at
                end,
                status = excluded.status,
                checked_at = excluded.checked_at`,
    });

    if (check.transitioned) {
      await db.execute({
        args: [randomUUID(), check.service, check.status, check.message, at],
        sql: `insert into status_events (id, service, status, message, at)
                values (?, ?, ?, ?, ?)`,
      });
    }

    const appendSample = async () => {
      await db.execute({
        args: [randomUUID(), check.service, check.status, check.latencyMs, at],
        sql: `insert into service_check_samples (id, service, status, latency_ms, at)
                values (?, ?, ?, ?, ?)`,
      });
      await db.execute({
        args: [check.service, check.service, SERVICE_CHECK_SAMPLES_KEEP],
        sql: `delete from service_check_samples
                where service = ?
                  and id not in (
                    select id from service_check_samples
                    where service = ?
                    order by at desc, id desc
                    limit ?
                  )`,
      });
    };

    if (strictSamples) {
      await appendSample();
    } else {
      try {
        await appendSample();
      } catch (error) {
        logEvent("error", "status.health-snapshot-write-failed", { error });
      }
    }
  }

  await db.execute({
    args: [STATUS_EVENTS_KEEP],
    sql: `delete from status_events
            where id not in (
              select id from status_events
              order by at desc, id desc
              limit ?
            )`,
  });
}

export async function recordHealthSnapshot(at: string, checks: HealthCheckInput[]): Promise<void> {
  await recordHealthSnapshotFor(await getDb(), at, checks);
}

export async function recordHealthSnapshotFor(
  db: Client,
  at: string,
  checks: HealthCheckInput[],
): Promise<void> {
  const snapshot = normalizeHealthSnapshot(at, checks);

  await writeHealthSnapshot(db, snapshot.at, snapshot.checks, false);
  await pruneRateLimitsAfterHealthSnapshot(db, snapshot.at);
}

export async function recordHealthSnapshotWithReceiptFor(
  client: Client,
  operationKey: string,
  producer: string,
  at: string,
  checks: HealthCheckInput[],
): Promise<OperationReceiptOutcome> {
  const snapshot = normalizeHealthSnapshot(at, checks);
  const requestDigest = await healthSnapshotRequestDigest(producer, snapshot.at, snapshot.checks);
  return executeReceiptBackedOperation({
    client,
    effect: async (transaction) => {
      await writeHealthSnapshot(transaction, snapshot.at, snapshot.checks, true);
      await pruneRateLimitCountersInSnapshot(transaction, snapshot.at);
      return {
        result: { at: snapshot.at },
        resultIdentity: operationKey,
        state: "committed",
      };
    },
    operationId: HEALTH_SNAPSHOT_OPERATION_ID,
    operationKey,
    requestDigest,
  });
}

async function pruneRateLimitsAfterHealthSnapshot(db: Client, at: string): Promise<void> {
  try {
    const pruned = await pruneRateLimitCountersInSnapshot(db, at);

    if (pruned > 0) {
      logEvent("info", "status.rate-limit-counters-pruned", { rows: pruned });
    }
  } catch (error) {
    logEvent("error", "status.rate-limit-prune-failed", { error });
  }
}

async function pruneRateLimitCountersInSnapshot(
  db: Pick<Client, "execute">,
  at: string,
): Promise<number> {
  const cutoff = new Date(Date.parse(at) - RATE_LIMIT_COUNTER_RETENTION_MS).toISOString();
  const result = await db.execute({
    args: [cutoff],
    sql: "delete from rate_limit_counters where window_start < ?",
  });
  return result.rowsAffected;
}
