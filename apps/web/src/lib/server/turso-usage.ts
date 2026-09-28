import { type Client } from "@libsql/client";
import {
  type TursoDatabaseUsage,
  type TursoUsageAlert,
  type TursoUsageAlertKey,
  type TursoUsageBoard,
  type TursoUsageHistoryDay,
  type TursoUsageSnapshot,
  type TursoUsageTotals,
} from "@fluncle/contracts";
import { TursoUsageSnapshotSchema } from "@fluncle/contracts/orpc";
import {
  billingCycle,
  crossedAlertLevels,
  type PriorReading,
  priceReading,
  RECENT_RATE_WINDOW_MS,
} from "../turso-pricing";
import { getTelemetryDb, typedRows } from "./db";
import { logEvent } from "./log";
import { getSetting, setSetting } from "./settings";
import { ApiError } from "./spotify";

export const TURSO_USAGE_THRESHOLD_KEY = "turso_usage_alert_threshold_usd";

export const TURSO_USAGE_THRESHOLD_DEFAULT_USD = 50;

export const TURSO_USAGE_HISTORY_DAYS = 45;

const FUTURE_TOLERANCE_MS = 10 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export type RecordTursoUsageInput = {
  databases: TursoDatabaseUsage[];
  observedAt: string;
  plan: { name: string; overages: boolean };
  upcomingInvoiceUsd: number | null;
  usage: TursoUsageTotals;
};

export type RecordTursoUsageResult = {
  pendingAlerts: TursoUsageAlert[];
  snapshot: TursoUsageSnapshot;
  stored: boolean;
  thresholdUsd: number;
};

export function parseThreshold(raw: string | undefined): number {
  const parsed = raw === undefined ? Number.NaN : Number(raw);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : TURSO_USAGE_THRESHOLD_DEFAULT_USD;
}

export async function readTursoUsageThreshold(): Promise<number> {
  return parseThreshold(await getSetting(TURSO_USAGE_THRESHOLD_KEY));
}

export async function setTursoUsageThreshold(thresholdUsd: number): Promise<number> {
  const rounded = Math.round(thresholdUsd * 100) / 100;

  await setSetting(TURSO_USAGE_THRESHOLD_KEY, String(rounded));

  return rounded;
}

function parseObservedAt(observedAt: string, nowMs: number): number {
  const observedAtMs = Date.parse(observedAt);

  if (!Number.isFinite(observedAtMs)) {
    throw new ApiError("invalid_observed_at", "observedAt is not an ISO timestamp", 400);
  }

  if (observedAtMs > nowMs + FUTURE_TOLERANCE_MS) {
    throw new ApiError("invalid_observed_at", "observedAt is in the future", 400);
  }

  return observedAtMs;
}

export function buildSnapshot(
  input: RecordTursoUsageInput,
  priors: readonly PriorReading[],
  observedAtMs: number,
): TursoUsageSnapshot {
  const cycle = billingCycle(observedAtMs);
  const priced = priceReading({
    cycle,
    databases: input.databases,
    observedAtMs,
    overagesEnabled: input.plan.overages,
    plan: input.plan.name,
    priors,
    usage: input.usage,
  });

  return {
    ...priced,
    cycle: cycle.cycle,
    cycleEnd: new Date(cycle.endMs).toISOString(),
    cycleStart: new Date(cycle.startMs).toISOString(),
    observedAt: new Date(observedAtMs).toISOString(),
    overagesEnabled: input.plan.overages,
    plan: input.plan.name,
    upcomingInvoiceUsd: input.upcomingInvoiceUsd,
  };
}

type PriorRow = {
  bytes_synced: number;
  observed_at: string;
  rows_read: number;
  rows_written: number;
  storage_bytes: number;
};

async function readPriors(
  db: Client,
  cycle: string,
  observedAtMs: number,
): Promise<PriorReading[]> {
  const result = await db.execute({
    args: [
      cycle,
      new Date(observedAtMs - RECENT_RATE_WINDOW_MS).toISOString(),
      new Date(observedAtMs).toISOString(),
    ],
    sql: `select observed_at, rows_read, rows_written, storage_bytes, bytes_synced
          from turso_usage_snapshots
          where cycle = ? and observed_at >= ? and observed_at < ?
          order by observed_at asc
          limit 200`,
  });

  return typedRows<PriorRow>(result.rows).map((row) => ({
    observedAtMs: Date.parse(row.observed_at),
    usage: {
      bytesSynced: Number(row.bytes_synced),
      rowsRead: Number(row.rows_read),
      rowsWritten: Number(row.rows_written),
      storageBytes: Number(row.storage_bytes),
    },
  }));
}

type AlertRow = {
  cycle: string;
  delivered_at: null | string;
  level_cents: number;
  projected_overage_usd: number;
  raised_at: string;
};

function toAlert(row: AlertRow): TursoUsageAlert {
  return {
    cycle: row.cycle,
    deliveredAt: row.delivered_at,
    levelUsd: Number(row.level_cents) / 100,
    projectedOverageUsd: Number(row.projected_overage_usd),
    raisedAt: row.raised_at,
  };
}

async function readCycleAlerts(db: Client, cycle: string): Promise<TursoUsageAlert[]> {
  const result = await db.execute({
    args: [cycle],
    sql: `select cycle, level_cents, projected_overage_usd, raised_at, delivered_at
          from turso_usage_alerts
          where cycle = ?
          order by level_cents asc`,
  });

  return typedRows<AlertRow>(result.rows).map(toAlert);
}

export async function recordTursoUsage(
  input: RecordTursoUsageInput,
  nowMs = Date.now(),
): Promise<RecordTursoUsageResult> {
  const observedAtMs = parseObservedAt(input.observedAt, nowMs);
  const thresholdUsd = await readTursoUsageThreshold();
  const db = await getTelemetryDb();

  if (!db) {
    logEvent("warn", "telemetry.turso-usage-unprovisioned", { observedAt: input.observedAt });

    return {
      pendingAlerts: [],
      snapshot: buildSnapshot(input, [], observedAtMs),
      stored: false,
      thresholdUsd,
    };
  }

  const cycle = billingCycle(observedAtMs).cycle;
  const snapshot = buildSnapshot(input, await readPriors(db, cycle, observedAtMs), observedAtMs);
  const createdAt = new Date(nowMs).toISOString();
  const crossed = crossedAlertLevels(thresholdUsd, snapshot.projectedOverageUsd);

  await db.batch(
    [
      {
        args: [
          `turso-usage:${snapshot.observedAt}`,
          snapshot.observedAt,
          snapshot.cycle,
          snapshot.plan,
          snapshot.priceTableVersion,
          input.usage.rowsRead,
          input.usage.rowsWritten,
          input.usage.storageBytes,
          input.usage.bytesSynced,
          snapshot.overageUsd,
          snapshot.projectedOverageUsd,
          JSON.stringify(snapshot),
          createdAt,
        ],
        sql: `insert into turso_usage_snapshots (
                id, observed_at, cycle, plan, price_table_version,
                rows_read, rows_written, storage_bytes, bytes_synced,
                overage_usd, projected_overage_usd, detail_json, created_at
              ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              on conflict(id) do update set
                plan = excluded.plan,
                price_table_version = excluded.price_table_version,
                rows_read = excluded.rows_read,
                rows_written = excluded.rows_written,
                storage_bytes = excluded.storage_bytes,
                bytes_synced = excluded.bytes_synced,
                overage_usd = excluded.overage_usd,
                projected_overage_usd = excluded.projected_overage_usd,
                detail_json = excluded.detail_json`,
      },
      ...crossed.map((levelUsd) => ({
        args: [snapshot.cycle, Math.round(levelUsd * 100), snapshot.projectedOverageUsd, createdAt],
        sql: `insert into turso_usage_alerts (cycle, level_cents, projected_overage_usd, raised_at)
              values (?, ?, ?, ?)
              on conflict(cycle, level_cents) do nothing`,
      })),
    ],
    "write",
  );

  const alerts = await readCycleAlerts(db, snapshot.cycle);

  return {
    pendingAlerts: alerts.filter((alert) => alert.deliveredAt === null),
    snapshot,
    stored: true,
    thresholdUsd,
  };
}

export async function acknowledgeTursoUsageAlerts(
  alerts: readonly TursoUsageAlertKey[],
  nowMs = Date.now(),
): Promise<number> {
  const db = await getTelemetryDb();

  if (!db || alerts.length === 0) {
    return 0;
  }

  const deliveredAt = new Date(nowMs).toISOString();
  const results = await db.batch(
    alerts.map((alert) => ({
      args: [deliveredAt, alert.cycle, Math.round(alert.levelUsd * 100)],
      sql: `update turso_usage_alerts
            set delivered_at = ?
            where cycle = ? and level_cents = ? and delivered_at is null`,
    })),
    "write",
  );

  return results.reduce((sum, result) => sum + result.rowsAffected, 0);
}

type HistoryRow = {
  bytes_synced: number;
  observed_at: string;
  overage_usd: number;
  projected_overage_usd: number;
  rows_read: number;
  rows_written: number;
  storage_bytes: number;
};

export function historyByDay(rows: readonly HistoryRow[]): TursoUsageHistoryDay[] {
  const byDay = new Map<string, HistoryRow>();

  for (const row of rows) {
    const day = row.observed_at.slice(0, 10);
    const current = byDay.get(day);

    if (!current || current.observed_at < row.observed_at) {
      byDay.set(day, row);
    }
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, row]) => ({
      bytesSynced: Number(row.bytes_synced),
      day,
      overageUsd: Number(row.overage_usd),
      projectedOverageUsd: Number(row.projected_overage_usd),
      rowsRead: Number(row.rows_read),
      rowsWritten: Number(row.rows_written),
      storageBytes: Number(row.storage_bytes),
    }));
}

export function parseSnapshotDetail(detailJson: string): TursoUsageSnapshot | null {
  try {
    const parsed = TursoUsageSnapshotSchema.safeParse(JSON.parse(detailJson));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function getTursoUsageBoard(nowMs = Date.now()): Promise<TursoUsageBoard> {
  const thresholdUsd = await readTursoUsageThreshold();
  const db = await getTelemetryDb();

  if (!db) {
    return { alerts: [], available: false, history: [], latest: null, thresholdUsd };
  }

  const [latestResult, historyResult] = await Promise.all([
    db.execute({
      args: [],
      sql: `select detail_json from turso_usage_snapshots order by observed_at desc limit 1`,
    }),
    db.execute({
      args: [new Date(nowMs - TURSO_USAGE_HISTORY_DAYS * DAY_MS).toISOString()],
      sql: `select observed_at, rows_read, rows_written, storage_bytes, bytes_synced,
                   overage_usd, projected_overage_usd
            from turso_usage_snapshots
            where observed_at >= ?
            order by observed_at asc
            limit 1000`,
    }),
  ]);
  const detail = typedRows<{ detail_json: string }>(latestResult.rows)[0]?.detail_json;
  const latest = detail === undefined ? null : parseSnapshotDetail(detail);
  const alerts = latest ? await readCycleAlerts(db, latest.cycle) : [];

  return {
    alerts,
    available: true,
    history: historyByDay(typedRows<HistoryRow>(historyResult.rows)),
    latest,
    thresholdUsd,
  };
}
