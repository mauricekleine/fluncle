// Estimate a scheduled service's NEXT run purely Worker-side, from its declared
// cadence + its last-seen timestamp — no box round-trip. This is the additive,
// zero-box-dependency half of cron next-run visibility (docs/admin-jobs.csv
// platform-ops "Surface every cron's last-run and next-run on web-admin"): /status
// already shows every cron's last-run FRESHNESS, but next-run existed nowhere except
// `hermes cron list` on the box.
//
// THE DATA IT HAS, AND WHAT THAT MAKES IT: the only per-service timestamp /status
// persists is `service_status.checked_at` — when the `fluncle-healthcheck` cron last
// PROBED the service (~10m cadence), NOT the cron's own last-run wall-clock. So this
// is deliberately an ESTIMATE: `lastSeen + cadence`, rolled forward past now to the
// next future instant, so a healthy 5m cron whose 10m probe is older than one cadence
// still reads a sensible upcoming tick, and a long-stale probe never yields a
// stuck-in-the-past answer. It is exact enough for a pure-interval cadence and
// honestly labeled "≈" at the surface; a WALL-CLOCK schedule (the daily backup's 1am,
// the weekly newsletter's Friday 15:00) drifts from a pure-cadence estimate anchored
// to last-run. Closing that drift is option (b): have the healthcheck POST the box's
// real `hermes cron list` next-run — accurate for cron-expression schedules, but it
// needs a box-script change + deploy, so it is a documented follow-up, not this pass.
//
// Kept a pure, dependency-free function so it is unit-tested in isolation
// (`next-run.test.ts`), the radio-schedule precedent.
//
// A cron that fires at a FIXED wall-clock time (the 01:00 audit, the Friday 15:00
// newsletter) carries a `schedule` in @fluncle/registry, and `nextScheduledRun` below
// computes its TRUE next fire (DST and all) instead of the cadence estimate — closing the
// drift the estimate is honestly-labeled `≈` about.

import { type CronSchedule } from "@fluncle/registry";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The next expected run of a service given its last-seen timestamp and its declared
 * cadence, as an ISO string — or `null` when either input is unusable (an unparseable
 * timestamp, a non-positive or non-finite cadence). The result is always strictly
 * after `nowIso`: `lastSeen + cadence` is stepped forward by whole cadence intervals
 * until it clears now, in O(1) even for a months-stale timestamp on a weekly cadence.
 */
export function estimateNextRun(
  lastSeenIso: string,
  cadenceMs: number,
  nowIso: string,
): string | null {
  const lastSeen = new Date(lastSeenIso).getTime();
  const now = new Date(nowIso).getTime();

  if (
    !Number.isFinite(lastSeen) ||
    !Number.isFinite(now) ||
    !Number.isFinite(cadenceMs) ||
    cadenceMs <= 0
  ) {
    return null;
  }

  let next = lastSeen + cadenceMs;

  // Roll forward to the first instant strictly after now. `floor(...) + 1` guarantees
  // strictness even when `now - next` lands on a clean multiple of the cadence.
  if (next <= now) {
    const stepsPast = Math.floor((now - next) / cadenceMs) + 1;
    next += stepsPast * cadenceMs;
  }

  return new Date(next).toISOString();
}

/**
 * The wall-clock parts a given instant shows in an IANA `tz`. Intl is a Worker-runtime
 * platform primitive — no dependency, so this stays as unit-testable as the rest of the file.
 */
function zonedParts(
  utcMs: number,
  tz: string,
): { day: number; hour: number; minute: number; month: number; second: number; year: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: tz,
    year: "numeric",
  }).formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  const hour = get("hour");

  return {
    day: get("day"),
    hour: hour === 24 ? 0 : hour, // some ICU builds render midnight as "24"
    minute: get("minute"),
    month: get("month"),
    second: get("second"),
    year: get("year"),
  };
}

/** The tz's UTC offset (localWall − utc) in ms at a given instant — always whole minutes. */
function zoneOffsetMs(utcMs: number, tz: string): number {
  const parts = zonedParts(utcMs, tz);
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  return Math.round((asIfUtc - utcMs) / MINUTE_MS) * MINUTE_MS;
}

/**
 * The UTC instant for a wall-clock `Y-M-D H:M` in `tz`, resolved in two passes so a DST
 * offset change lands correctly (exact except at the ~1h transition seam itself — fine for a
 * dashboard's next-run estimate).
 */
function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset1 = zoneOffsetMs(asIfUtc, tz);
  const utc = asIfUtc - offset1;
  const offset2 = zoneOffsetMs(utc, tz);

  return offset2 === offset1 ? utc : asIfUtc - offset2;
}

/**
 * The next fire of a fixed wall-clock cron `schedule` (a local `HH:MM`, optionally on one
 * weekday) as an ISO string strictly after `nowIso` — or `null` on unusable input. Walks
 * calendar days forward IN THE SCHEDULE'S TZ (DST handled per-day), up to 8 days, which
 * covers any daily or weekly schedule. The ACCURATE alternative to `estimateNextRun` for a
 * wall-clock cron.
 */
export function nextScheduledRun(schedule: CronSchedule, nowIso: string): string | null {
  const now = new Date(nowIso).getTime();
  const [hour, minute] = schedule.time.split(":").map(Number);

  if (
    hour === undefined ||
    minute === undefined ||
    !Number.isFinite(now) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute)
  ) {
    return null;
  }

  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    const cand = zonedParts(now + dayOffset * DAY_MS, schedule.tz);

    if (schedule.weekday !== undefined) {
      const dow = new Date(Date.UTC(cand.year, cand.month - 1, cand.day)).getUTCDay();

      if (dow !== schedule.weekday) {
        continue;
      }
    }

    const fire = zonedWallClockToUtc(cand.year, cand.month, cand.day, hour, minute, schedule.tz);

    if (fire > now) {
      return new Date(fire).toISOString();
    }
  }

  return null;
}

/**
 * A scheduled next-run rendered in its own IANA `tz` as "Jul 10, 01:00 Amsterdam" — the local
 * face of the fire (paired with its UTC form + countdown on /status). Empty on a bad instant.
 */
export function formatZonedTime(iso: string, tz: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const stamp = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    timeZone: tz,
  }).format(date);
  const city = (tz.split("/").pop() ?? tz).replace(/_/g, " ");

  return `${stamp} ${city}`;
}

/**
 * A terse "in 5m" / "in 3h" / "in 2d" countdown from `nowIso` to `targetIso`,
 * matching the /status page's whole-unit tabular register. Anything under a minute
 * out — or an unparseable/past instant — reads "imminent" (a next tick that close is,
 * for the operator's purposes, about to fire).
 */
export function formatCountdown(targetIso: string, nowIso: string): string {
  const ms = new Date(targetIso).getTime() - new Date(nowIso).getTime();

  if (!Number.isFinite(ms) || ms < MINUTE_MS) {
    return "imminent";
  }

  const minutes = Math.floor(ms / MINUTE_MS);

  if (minutes < 60) {
    return `in ${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `in ${hours}h`;
  }

  return `in ${Math.floor(hours / 24)}d`;
}

/**
 * A cadence in ms rendered as a terse whole-unit interval ("5m" / "1h" / "7d") for the
 * "every …" schedule label. Uses the largest clean unit (a 60-minute cadence reads
 * "1h", not "60m"; a 7-day cadence "7d", not "168h"); a non-whole cadence falls back to
 * the largest unit that divides it, minutes at the floor.
 */
export function formatCadence(cadenceMs: number): string {
  if (!Number.isFinite(cadenceMs) || cadenceMs <= 0) {
    return "";
  }

  if (cadenceMs % DAY_MS === 0) {
    return `${cadenceMs / DAY_MS}d`;
  }

  if (cadenceMs % HOUR_MS === 0) {
    return `${cadenceMs / HOUR_MS}h`;
  }

  return `${Math.max(1, Math.floor(cadenceMs / MINUTE_MS))}m`;
}
