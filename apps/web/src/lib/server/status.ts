// The service-health status store — the server side of the public /status
// dashboard. Mirrors `tracks.ts`: `getDb()` + raw SQL + `typedRows`, no Drizzle
// query builder. Two halves:
//
//   - READS (the page): `getServiceStatuses` (every `service_status` row, the
//     grid) + `getRecentStatusEvents` (the most-recent transitions, the feed).
//   - WRITE (the agent cron): `recordHealthSnapshot` — for each check, upsert the
//     single `service_status` row (carry `since` forward while the status is
//     unchanged, reset it on a flip), append a `status_events` row for every
//     `transitioned` check, then prune the ledger to its most recent 200 rows.
//
// Everything here is PUBLIC-SAFE by construction: only service name + status +
// short message + latency + timestamps ever flow through, never an internal
// address or raw error body (the probe is responsible for keeping `message` clean).

import { randomUUID } from "node:crypto";
import { getDb, typedRows } from "./db";

/** The three-state health enum, shared with the `@fluncle/contracts` snapshot schema. */
export type ServiceHealthStatus = "ok" | "degraded" | "down";

/** A current-state row as `service_status` stores it (the page grid). */
export type ServiceStatusRow = {
  checked_at: string;
  latency_ms: number | null;
  message: string | null;
  service: string;
  since: string;
  status: ServiceHealthStatus;
};

/** A transition row as `status_events` stores it (the recent-events feed). */
export type StatusEventRow = {
  at: string;
  id: string;
  message: string | null;
  service: string;
  status: ServiceHealthStatus;
};

/** One probed service in an incoming health snapshot (the `record_health` body). */
export type HealthCheckInput = {
  latencyMs: number | null;
  message: string | null;
  service: string;
  status: ServiceHealthStatus;
  transitioned: boolean;
};

// The ledger is trimmed to this many most-recent rows on every write — a status
// page never needs deep history, and this keeps the table bounded without a cron.
const STATUS_EVENTS_KEEP = 200;

/** Every `service_status` row, newest-checked first — the page's service grid. */
export async function getServiceStatuses(): Promise<ServiceStatusRow[]> {
  const db = await getDb();
  const result = await db.execute(
    `select service, status, message, latency_ms, checked_at, since
       from service_status
       order by checked_at desc`,
  );

  return typedRows<ServiceStatusRow>(result.rows);
}

/** The most-recent `limit` transition rows, newest first — the page's events feed. */
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

/**
 * Persist one health snapshot. For each check: UPSERT its `service_status` row,
 * setting `since` to `at` ONLY when the incoming status differs from the stored
 * row's status (otherwise the stored `since` is preserved — the conflict update
 * keeps the existing value when the status is unchanged). A `transitioned` check
 * also appends a `status_events` row. After the writes, the ledger is pruned to
 * its most recent `STATUS_EVENTS_KEEP` rows.
 */
export async function recordHealthSnapshot(at: string, checks: HealthCheckInput[]): Promise<void> {
  const db = await getDb();

  for (const check of checks) {
    // `since` preservation lives in the conflict clause: on a fresh row it is the
    // incoming `at`; on an existing row it stays put while the status is unchanged
    // and resets to the new `checked_at` only when the status actually flips. This
    // is the authoritative computation — independent of the probe's `transitioned`
    // flag (which only governs the ledger), so a stored `since` can never drift.
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
  }

  // Prune the append-only ledger to the most recent rows. Keyed on (at, id) so the
  // keep-set matches the recent-events read order and the tiebreak is stable.
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
