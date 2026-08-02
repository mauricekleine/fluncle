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
import { cronSurfaces } from "@fluncle/registry";
import { SELF_POSTED_AUTOMATION_ORDER } from "../status-services";
import { getDb, typedRows } from "./db";
import { logEvent } from "./log";
import { pruneRateLimitCounters } from "./rate-limit";

/** The three-state health enum, shared with the `@fluncle/contracts` snapshot schema. */
export type ServiceHealthStatus = "ok" | "degraded" | "down";

/** A current-state row, including a synthetic never-reported expected writer (the page grid). */
export type ServiceStatusRow = {
  checked_at: string | null;
  latency_ms: number | null;
  message: string | null;
  service: string;
  since: string | null;
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

// The SHARED expected-writers roster. Registry cron ids are build-bound to the
// committed timer units by docs/agents/hermes/scripts/cron-roster.test.ts, so the
// read reuses that derived truth instead of keeping another list of 40+ cron ids.
// The three self-posted ids already form /status's explicit non-registry roster;
// their client-safe module keeps the page and absence detection on one list.
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

// `checked_at` records when a row WRITER last posted, not when the underlying cron
// last ran. The healthcheck prober owns every registry-cron row and reports all of
// them on its own 10m cadence; applying (say) cron.live's 1m marker cadence to this
// timestamp would falsely age that row out between ordinary prober ticks. The three
// self-deploy rows own their hourly POSTs.
const STATUS_PROBER_CADENCE_MS = statusProberCadenceMs();
const EXPECTED_STATUS_WRITER_CADENCE_MS = new Map<string, number>([
  ...CRON_SURFACES.map((surface) => [surface.name, STATUS_PROBER_CADENCE_MS] as const),
  ...SELF_POSTED_AUTOMATION_ORDER.map((service) => [service, SELF_POSTED_CADENCE_MS] as const),
]);

// Service ids with no current prober writes — stale `service_status` rows from probes
// outside the active registry. The healthcheck cron upserts but never
// deletes, so a retired id lingers stale forever until an operator drops the row by
// hand. Filtering them here (the SHARED read) makes them vanish from EVERY surface
// at once — the /status page, /api/status, the CLI `status` command, and the MCP
// `get_status` tool — so none of them shows a permanently-stale row.
// Remove an id's registry surface before adding it here, or absence synthesis will resurrect it.
//
// `automation` and `cron.artist-follow` have no current prober. The box healthcheck can
// continue to upsert those ids, so they stay in this filter until their rows are removed.
// Add an id here
// when a probe is retired; remove it once the underlying `service_status` row is dropped.
// `cron.apple-releases` is an excluded legacy id; the active freshness tap is
// `cron.label-releases`, and the stale bare-slug row must not appear on /status.
// `cron.clip-drip` is the case the NO_RUNS_GRACE_MS note below was written about: the
// clip→Instagram drip-feed was registered but never deployed (stripped from the image bake,
// no timer), so it posted "no runs yet" forever. Its registry surface + prober row are gone;
// this keeps the already-written `service_status` row off the board.
const RETIRED_SERVICE_IDS = new Set([
  "automation",
  "cron.apple-releases",
  "cron.artist-follow",
  "cron.clip-drip",
]);

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

/**
 * A green row older than three of its writer's reporting cycles is no longer evidence
 * of health. Match `judgeCron`'s 3× cadence rule (including its 90s jitter floor) at
 * the shared read so a dead writer cannot leave every consumer permanently green.
 */
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

/** Expected writer ids that have never produced a row must be visible, never absent-green. */
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

/**
 * Every CURRENT `service_status` row, newest-checked first — the page's service grid.
 * Retired/orphaned ids (`RETIRED_SERVICE_IDS`) are filtered out at this shared read so
 * a stale row never surfaces on any consumer (page, /api/status, CLI, MCP) — and a cron
 * stuck on "no runs yet", a stale-green report, or an expected writer with no row is
 * downgraded here too, for the same reason: one read, so every consumer tells the same truth.
 */
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
      logEvent("error", "status.health-snapshot-write-failed", { error });
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

  // And prune the rate limiter's spent windows, which nothing deleted from before (rate-limit.ts
  // `pruneRateLimitCounters`). It rides here because this is the repo's periodic-maintenance write
  // and a housekeeping delete must never sit on a read a caller is waiting for. NON-CRITICAL, the
  // samples-ledger discipline above: a failure here is logged and swallowed, because the health
  // snapshot this function exists for is already complete and must not be lost to upkeep.
  try {
    const pruned = await pruneRateLimitCounters();

    if (pruned > 0) {
      logEvent("info", "status.rate-limit-counters-pruned", { rows: pruned });
    }
  } catch (error) {
    logEvent("error", "status.rate-limit-prune-failed", { error });
  }
}
