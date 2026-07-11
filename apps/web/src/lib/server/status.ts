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

/** One historical check sample as `service_check_samples` stores it (the uptime bar). */
export type ServiceCheckSampleRow = {
  at: string;
  latency_ms: number | null;
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

// Each service's recent-check ledger is trimmed to this many most-recent rows on
// every write — the uptime bar shows the last N checks (≈ N × the 10m cadence),
// bounded without a cron. It fills in over time, then rolls.
const SERVICE_CHECK_SAMPLES_KEEP = 90;

// Service ids no current prober writes — orphaned `service_status` rows left over
// from a probe that was retired or renamed. The healthcheck cron upserts but never
// deletes, so a retired id lingers stale forever until an operator drops the row by
// hand. Filtering them here (the SHARED read) makes them vanish from EVERY surface
// at once — the /status page, /api/status, the CLI `status` command, and the MCP
// `get_status` tool — so none of them shows a permanently-stale row.
//
// `automation` is the known orphan: PR #177 split the single aggregate probe into one
// row per Hermes cron (`cron.enrich`, `cron.render`, …), so the old `automation`
// aggregate is no longer posted. `cron.artist-follow` is retired too — the flaky
// auto-follow cron was removed (2026-07-08), but the box's old-image healthcheck keeps
// upserting it until it re-bakes, and the upserted row lingers after. Add an id here
// when a probe is retired; remove it once the underlying `service_status` row is dropped.
const RETIRED_SERVICE_IDS = new Set(["automation", "cron.artist-follow"]);

/**
 * How long a cron may report "no runs yet" before that stops meaning "freshly rebuilt box"
 * and starts meaning "this was never deployed". The box healthcheck emits no-runs-yet as `ok`
 * on purpose — a box that just rebuilt hasn't ticked, and that is not a fault. But the grace
 * was UNBOUNDED, so a cron registered in `@fluncle/registry` but never installed on the box
 * sat permanently GREEN: `cron.clip-drip` reported ok/"no runs yet" for days while rave-02 had
 * no timer and no script for it. A monitor that reassures you about a job that does not exist
 * is worse than no monitor. After this window, say so.
 */
const NO_RUNS_GRACE_MS = 24 * 60 * 60 * 1000;

/** The box healthcheck's no-data note (fluncle-healthcheck.ts emits it as ok). */
const NO_RUNS_MESSAGE = /no runs yet/i;

/**
 * A cron that has reported "no runs yet" since before the grace window has not been ticking —
 * it has never run at all. Report that honestly instead of a green row.
 */
function honestNoRuns(row: ServiceStatusRow, now: number): ServiceStatusRow {
  if (row.status !== "ok" || !NO_RUNS_MESSAGE.test(row.message ?? "")) {
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

/**
 * Every CURRENT `service_status` row, newest-checked first — the page's service grid.
 * Retired/orphaned ids (`RETIRED_SERVICE_IDS`) are filtered out at this shared read so
 * a stale row never surfaces on any consumer (page, /api/status, CLI, MCP) — and a cron
 * stuck on "no runs yet" past the grace window is downgraded here too, for the same reason:
 * one read, so every consumer tells the same truth.
 */
export async function getServiceStatuses(now = Date.now()): Promise<ServiceStatusRow[]> {
  const db = await getDb();
  const result = await db.execute(
    `select service, status, message, latency_ms, checked_at, since
       from service_status
       order by checked_at desc`,
  );

  return typedRows<ServiceStatusRow>(result.rows)
    .filter((row) => !RETIRED_SERVICE_IDS.has(row.service))
    .map((row) => honestNoRuns(row, now));
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
 * The recent check samples grouped by service, OLDEST→newest within each (so the bar
 * renders left-to-right, oldest at the left). A plain object (JSON-serialisable across
 * the loader boundary), keyed by service id; the table is bounded by the per-write
 * prune, so this reads at most SERVICE_CHECK_SAMPLES_KEEP × service-count rows.
 */
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

    // Append this check to the recent-samples ledger (the uptime bar), then prune
    // this service to its most-recent SERVICE_CHECK_SAMPLES_KEEP rows. NON-CRITICAL:
    // the bar is an enhancement, so a failure here (e.g. the table not yet migrated
    // during a deploy window) must never lose the service_status upsert + the event
    // above — it is caught and logged, not thrown.
    try {
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
    } catch (error) {
      console.error("recordHealthSnapshot: sample-ledger write failed (non-critical)", error);
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
